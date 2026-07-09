"""The mock endpoints return provider-shaped JSON (in-process, via TestClient)."""

from fastapi.testclient import TestClient

from cos.mocks.app import app

client = TestClient(app)


def test_gmail_list_and_get():
    r = client.get("/gmail/v1/users/me/messages", params={"labelIds": "INBOX"})
    body = r.json()
    assert body["messages"], "expected inbox messages"
    assert {"id", "threadId"} <= body["messages"][0].keys()
    mid = body["messages"][0]["id"]
    msg = client.get(f"/gmail/v1/users/me/messages/{mid}").json()
    headers = {h["name"] for h in msg["payload"]["headers"]}
    assert {"From", "To", "Subject"} <= headers


def test_x_mentions_shape():
    body = client.get("/2/users/1000000000000000001/mentions").json()
    assert "data" in body and "includes" in body
    assert body["meta"]["result_count"] == len(body["data"])


def test_whatsapp_and_send():
    body = client.get("/v19.0/100000000000001/messages").json()
    assert body["messages"] and body["contacts"]
    sent = client.post("/v19.0/100000000000001/messages",
                       json={"messaging_product": "whatsapp", "to": "14155550111",
                             "type": "text", "text": {"body": "hi"}}).json()
    assert sent["messages"][0]["id"].startswith("wamid.")


def test_asana_crud():
    tasks = client.get("/api/1.0/tasks").json()["data"]
    assert len(tasks) >= 20
    created = client.post("/api/1.0/tasks",
                          json={"data": {"name": "T", "projects": ["1201000000000001"]}})
    gid = created.json()["data"]["gid"]
    assert client.get(f"/api/1.0/tasks/{gid}").json()["data"]["name"] == "T"


def test_asana_milestones_and_stories():
    ms = client.get("/api/1.0/tasks", params={"is_milestone": True}).json()["data"]
    assert ms and all(t["is_milestone"] for t in ms)
    # create a milestone via resource_subtype
    made = client.post("/api/1.0/tasks", json={"data": {
        "name": "M", "resource_subtype": "milestone",
        "projects": ["1201000000000001"]}}).json()["data"]
    assert made["is_milestone"] is True
    # comment (story) round-trip
    gid = made["gid"]
    client.post(f"/api/1.0/tasks/{gid}/stories", json={"data": {"text": "hello"}})
    stories = client.get(f"/api/1.0/tasks/{gid}/stories").json()["data"]
    assert stories[0]["text"] == "hello"
    # delete
    assert client.delete(f"/api/1.0/tasks/{gid}").status_code == 200
