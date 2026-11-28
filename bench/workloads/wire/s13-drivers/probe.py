import json
import os

import pymongo
from pymongo.auth_oidc import OIDCCallback, OIDCCallbackResult


class Callback(OIDCCallback):
    def fetch(self, context):
        return OIDCCallbackResult(access_token=os.environ["CANOPY_S13_TOKEN"])


def unified(items, path):
    with open(path, encoding="utf-8") as source:
        fixture = json.load(source)
    operation = fixture["operation"]
    args = operation["arguments"]
    match operation["name"]:
        case "find":
            cursor = items.find(args["filter"])
            if "sort" in args:
                cursor.sort(list(args["sort"].items()))
            if "skip" in args:
                cursor.skip(args["skip"])
            if "limit" in args:
                cursor.limit(args["limit"])
            if "batchSize" in args:
                cursor.batch_size(args["batchSize"])
            result = list(cursor)
        case "aggregate":
            result = list(items.aggregate(args["pipeline"], batchSize=args["batchSize"]))
        case "insertOne":
            result = {"insertedId": items.insert_one(args["document"]).inserted_id}
        case "updateOne":
            update = items.update_one(args["filter"], args["update"])
            result = {
                "matchedCount": update.matched_count,
                "modifiedCount": update.modified_count,
                "upsertedCount": int(update.upserted_id is not None),
            }
        case name:
            raise RuntimeError(f"Unexpected operation: {name}")
    with open(fixture["result"], "w", encoding="utf-8") as output:
        json.dump(result, output)


with pymongo.MongoClient(
    os.environ["CANOPY_S13_URL"],
    authMechanism="MONGODB-OIDC",
    authMechanismProperties={"OIDC_CALLBACK": Callback()},
    retryWrites=False,
    serverSelectionTimeoutMS=3000,
) as client:
    items = client[os.getenv("CANOPY_S13_DATABASE", "canopy_s13")][os.getenv("CANOPY_S13_COLLECTION", "items")]
    if path := os.environ.get("CANOPY_S13_CRUD_CASE"):
        unified(items, path)
        raise SystemExit(0)
    ids = [item["_id"] for item in items.find().sort("_id", 1).limit(5).batch_size(2)]
    if ids != [1, 2, 3, 4, 5] or items.find_one({"ownerId": "bob"}) is not None:
        raise RuntimeError("Unexpected Python driver result")
    doc_id = int(os.environ["CANOPY_S13_WRITE_ID"])
    inserted = items.insert_one({"_id": doc_id, "ownerId": "alice", "title": "before"})
    updated = items.update_one({"_id": doc_id}, {"$set": {"title": "after"}})
    documents = list(items.aggregate([{"$match": {"_id": doc_id}}]))
    if inserted.inserted_id != doc_id or updated.modified_count != 1 or documents != [
        {"_id": doc_id, "ownerId": "alice", "title": "after"}
    ]:
        raise RuntimeError("Unexpected Python write result")
    print(f"PyMongo {pymongo.version}: authenticated reads, pagination, aggregation and writes passed")
