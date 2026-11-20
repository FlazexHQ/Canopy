import os

import pymongo
from pymongo.auth_oidc import OIDCCallback, OIDCCallbackResult


class Callback(OIDCCallback):
    def fetch(self, context):
        return OIDCCallbackResult(access_token=os.environ["CANOPY_S13_TOKEN"])


with pymongo.MongoClient(
    os.environ["CANOPY_S13_URL"],
    authMechanism="MONGODB-OIDC",
    authMechanismProperties={"OIDC_CALLBACK": Callback()},
    retryWrites=False,
    serverSelectionTimeoutMS=3000,
) as client:
    items = client.canopy_s13.items
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
