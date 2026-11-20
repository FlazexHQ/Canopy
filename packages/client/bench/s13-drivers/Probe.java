import com.mongodb.ConnectionString;
import com.mongodb.MongoClientSettings;
import com.mongodb.MongoCredential;
import com.mongodb.client.MongoClients;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.TimeUnit;
import org.bson.Document;

class Probe {
    public static void main(String[] args) {
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
            var items = client.getDatabase("canopy_s13").getCollection("items");
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
