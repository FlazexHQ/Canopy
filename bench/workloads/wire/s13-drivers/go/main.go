package main

import (
	"context"
	"encoding/json"
	"fmt"
	"log"
	"os"
	"slices"
	"strconv"
	"time"

	"go.mongodb.org/mongo-driver/v2/bson"
	"go.mongodb.org/mongo-driver/v2/mongo"
	"go.mongodb.org/mongo-driver/v2/mongo/options"
)

func unified(ctx context.Context, items *mongo.Collection, path string) error {
	input, err := os.ReadFile(path)
	if err != nil {
		return err
	}
	var fixture struct {
		Operation struct {
			Name      string
			Arguments json.RawMessage
		}
		Result string
	}
	if err := json.Unmarshal(input, &fixture); err != nil {
		return err
	}
	var args struct {
		Filter    bson.D
		Sort      bson.D
		Skip      *int64
		Limit     *int64
		BatchSize *int32 `bson:"batchSize"`
		Pipeline  mongo.Pipeline
		Document  bson.D
		Update    bson.D
	}
	if err := bson.UnmarshalExtJSON(fixture.Operation.Arguments, false, &args); err != nil {
		return err
	}
	var result any
	var cursor *mongo.Cursor
	switch fixture.Operation.Name {
	case "find":
		if args.Filter == nil {
			args.Filter = bson.D{}
		}
		find := options.Find()
		if args.Sort != nil {
			find.SetSort(args.Sort)
		}
		if args.Skip != nil {
			find.SetSkip(*args.Skip)
		}
		if args.Limit != nil {
			find.SetLimit(*args.Limit)
		}
		if args.BatchSize != nil {
			find.SetBatchSize(*args.BatchSize)
		}
		cursor, err = items.Find(ctx, args.Filter, find)
	case "aggregate":
		aggregate := options.Aggregate()
		if args.BatchSize != nil {
			aggregate.SetBatchSize(*args.BatchSize)
		}
		cursor, err = items.Aggregate(ctx, args.Pipeline, aggregate)
	case "insertOne":
		var write *mongo.InsertOneResult
		write, err = items.InsertOne(ctx, args.Document)
		if err == nil {
			result = bson.M{"insertedId": write.InsertedID}
		}
	case "updateOne":
		var write *mongo.UpdateResult
		write, err = items.UpdateOne(ctx, args.Filter, args.Update)
		if err == nil {
			result = bson.M{"matchedCount": write.MatchedCount, "modifiedCount": write.ModifiedCount, "upsertedCount": write.UpsertedCount}
		}
	default:
		return fmt.Errorf("unexpected operation: %s", fixture.Operation.Name)
	}
	if err != nil {
		return err
	}
	if cursor != nil {
		var docs []bson.M
		if err := cursor.All(ctx, &docs); err != nil {
			return err
		}
		result = docs
	}
	output, err := json.Marshal(result)
	if err != nil {
		return err
	}
	return os.WriteFile(fixture.Result, output, 0600)
}

func probe(ctx context.Context) error {
	credential := options.Credential{
		AuthMechanism: "MONGODB-OIDC",
		OIDCMachineCallback: func(context.Context, *options.OIDCArgs) (*options.OIDCCredential, error) {
			return &options.OIDCCredential{AccessToken: os.Getenv("CANOPY_S13_TOKEN")}, nil
		},
	}
	client, err := mongo.Connect(options.Client().
		ApplyURI(os.Getenv("CANOPY_S13_URL")).
		SetAuth(credential).
		SetRetryWrites(false).
		SetServerSelectionTimeout(3 * time.Second))
	if err != nil {
		return err
	}
	defer client.Disconnect(ctx)
	database, collection := "canopy_s13", "items"
	if value := os.Getenv("CANOPY_S13_DATABASE"); value != "" {
		database = value
	}
	if value := os.Getenv("CANOPY_S13_COLLECTION"); value != "" {
		collection = value
	}
	items := client.Database(database).Collection(collection)
	if path := os.Getenv("CANOPY_S13_CRUD_CASE"); path != "" {
		return unified(ctx, items, path)
	}
	cursor, err := items.Find(ctx, bson.D{}, options.Find().SetSort(bson.D{{Key: "_id", Value: 1}}).
		SetLimit(5).SetBatchSize(2))
	if err != nil {
		return err
	}
	var docs []struct {
		ID int `bson:"_id"`
	}
	if err := cursor.All(ctx, &docs); err != nil {
		return err
	}
	ids := make([]int, 0, len(docs))
	for _, doc := range docs {
		ids = append(ids, doc.ID)
	}
	if !slices.Equal(ids, []int{1, 2, 3, 4, 5}) {
		return fmt.Errorf("unexpected IDs %v", ids)
	}
	cursor, err = items.Find(ctx, bson.D{{Key: "ownerId", Value: "bob"}}, options.Find().SetLimit(1))
	if err != nil {
		return err
	}
	defer cursor.Close(ctx)
	if cursor.Next(ctx) {
		return fmt.Errorf("read another user's documents")
	}
	if err := cursor.Err(); err != nil {
		return err
	}
	id, err := strconv.Atoi(os.Getenv("CANOPY_S13_WRITE_ID"))
	if err != nil {
		return err
	}
	query := bson.D{{Key: "_id", Value: id}}
	_, err = items.InsertOne(ctx, bson.D{{Key: "_id", Value: id}, {Key: "ownerId", Value: "alice"}, {Key: "title", Value: "before"}})
	if err != nil {
		return err
	}
	updated, err := items.UpdateOne(ctx, query, bson.D{{Key: "$set", Value: bson.D{{Key: "title", Value: "after"}}}})
	if err != nil {
		return err
	}
	aggregate, err := items.Aggregate(ctx, mongo.Pipeline{bson.D{{Key: "$match", Value: query}}})
	if err != nil {
		return err
	}
	var result []struct {
		Title string `bson:"title"`
	}
	if err := aggregate.All(ctx, &result); err != nil {
		return err
	}
	if updated.ModifiedCount != 1 || len(result) != 1 || result[0].Title != "after" {
		return fmt.Errorf("unexpected Go write result")
	}
	return nil
}

func main() {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	if err := probe(ctx); err != nil {
		log.Fatal(err)
	}
	if os.Getenv("CANOPY_S13_CRUD_CASE") == "" {
		fmt.Println("Go driver v2.5.0: authenticated reads, pagination, aggregation and writes passed")
	}
}
