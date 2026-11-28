import com.mongodb.ConnectionString;
import com.mongodb.MongoClientSettings;
import com.mongodb.MongoCredential;
import com.mongodb.client.MongoClients;
import com.mongodb.client.MongoCollection;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.TimeUnit;
import java.util.stream.Collectors;
import org.bson.Document;

class Probe {
    private static void unified(MongoCollection<Document> items, String path) throws Exception {
        var fixture = Document.parse(Files.readString(Path.of(path)));
        var operation = fixture.get("operation", Document.class);
        var args = operation.get("arguments", Document.class);
        String result;
        switch (operation.getString("name")) {
            case "find" -> {
                var cursor = items.find(args.get("filter", Document.class));
                if (args.containsKey("sort")) cursor.sort(args.get("sort", Document.class));
                if (args.containsKey("skip")) cursor.skip(args.getInteger("skip"));
                if (args.containsKey("limit")) cursor.limit(args.getInteger("limit"));
                if (args.containsKey("batchSize")) cursor.batchSize(args.getInteger("batchSize"));
                result = encode(cursor.into(new ArrayList<>()));
            }
            case "aggregate" -> {
                var cursor = items.aggregate(args.getList("pipeline", Document.class));
                if (args.containsKey("batchSize")) cursor.batchSize(args.getInteger("batchSize"));
                result = encode(cursor.into(new ArrayList<>()));
            }
            case "insertOne" -> {
                var write = items.insertOne(args.get("document", Document.class));
                result = new Document("insertedId", write.getInsertedId().asInt32().getValue()).toJson();
            }
            case "updateOne" -> {
                var write = items.updateOne(args.get("filter", Document.class), args.get("update", Document.class));
                result = new Document("matchedCount", write.getMatchedCount())
                    .append("modifiedCount", write.getModifiedCount())
                    .append("upsertedCount", write.getUpsertedId() == null ? 0 : 1)
                    .toJson();
            }
            default -> throw new IllegalArgumentException("Unexpected operation: " + operation.getString("name"));
        }
        Files.writeString(Path.of(fixture.getString("result")), result);
    }

    private static String encode(List<Document> documents) {
        return documents.stream().map(Document::toJson).collect(Collectors.joining(",", "[", "]"));
    }

    public static void main(String[] args) throws Exception {
        var credential = MongoCredential.createOidcCredential(null)
            .withMechanismProperty(
                MongoCredential.OIDC_CALLBACK_KEY,
                (MongoCredential.OidcCallback) context ->
                    new MongoCredential.OidcCallbackResult(System.getenv("CANOPY_S13_TOKEN"))
            );
        var settings = MongoClientSettings.builder()
            .applyConnectionString(new ConnectionString(System.getenv("CANOPY_S13_URL")))
            .credential(credential)
            .retryWrites(false)
            .applyToClusterSettings(cluster -> cluster.serverSelectionTimeout(3, TimeUnit.SECONDS))
            .build();
        try (var client = MongoClients.create(settings)) {
            var items = client.getDatabase(System.getenv().getOrDefault("CANOPY_S13_DATABASE", "canopy_s13"))
                .getCollection(System.getenv().getOrDefault("CANOPY_S13_COLLECTION", "items"));
            var fixture = System.getenv("CANOPY_S13_CRUD_CASE");
            if (fixture != null) {
                unified(items, fixture);
                return;
            }
            var documents = items.find().sort(new Document("_id", 1)).limit(5).batchSize(2)
                .into(new ArrayList<>());
            var ids = documents.stream().map(document -> document.getInteger("_id")).toList();
            if (!ids.equals(List.of(1, 2, 3, 4, 5)) ||
                items.find(new Document("ownerId", "bob")).limit(1).iterator().hasNext()) {
                throw new IllegalStateException("Unexpected Java driver result");
            }
            int id = Integer.parseInt(System.getenv("CANOPY_S13_WRITE_ID"));
            var query = new Document("_id", id);
            items.insertOne(new Document("_id", id).append("ownerId", "alice").append("title", "before"));
            var updated = items.updateOne(query, new Document("$set", new Document("title", "after")));
            var aggregate = items.aggregate(List.of(new Document("$match", query))).into(new ArrayList<>());
            if (updated.getModifiedCount() != 1 || aggregate.size() != 1 ||
                !aggregate.getFirst().getString("title").equals("after")) {
                throw new IllegalStateException("Unexpected Java write result");
            }
            System.out.println("Java driver 5.6.4: authenticated reads, pagination, aggregation and writes passed");
        }
    }
}
