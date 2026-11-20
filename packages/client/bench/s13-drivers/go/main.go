package main

import (
	"context"
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
	items := client.Database("canopy_s13").Collection("items")
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
	fmt.Println("Go driver v2.5.0: authenticated reads, pagination, aggregation and writes passed")
}
