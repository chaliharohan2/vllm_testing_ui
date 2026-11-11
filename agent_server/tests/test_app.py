import json

from agent_server.app import build_app
from agent_server.llm import LLMResponse

from .conftest import call


def sse_events(text):
    return [json.loads(line[5:]) for line in text.splitlines() if line.startswith("data:")]


async def test_chat_streams_and_is_stored_with_its_artifact(aiohttp_client, db, fake_llm, tmp_path):
    fake_llm([
        LLMResponse(tool_calls=[call("create_artifact", title="Page", type="html", content="<h1>Hi</h1>")]),
        LLMResponse(text="Here it is."),
    ])
    client = await aiohttp_client(build_app(db))
    response = await client.post("/api/chat", json={
        "message": {"content": "Make a page"}, "tools": ["artifacts", "nonsense"], "workdir": str(tmp_path),
        "settings": {"model": "m", "temperature": 0.2}})
    events = sse_events(await response.text())
    assert events[0]["type"] == "start" and events[0]["title"] == "Make a page"
    assert events[-1]["type"] == "done" and events[-1]["status"] == "completed"
    chat_id = events[0]["chat_id"]

    chats = await (await client.get("/api/chats")).json()
    assert chats["chats"][0]["id"] == chat_id
    loaded = await (await client.get(f"/api/chats/{chat_id}")).json()
    assert loaded["chat"]["settings"]["tools"] == ["artifacts"]
    answer = loaded["messages"][1]
    link = answer["content"].split("(#artifact/")[1].split(")")[0]
    artifact_id, version = link.split("/")
    artifact = await (await client.get(f"/api/artifacts/{artifact_id}?version={version}")).json()
    assert artifact["content"] == "<h1>Hi</h1>" and artifact["kind"] == "html"
    assert (await client.delete(f"/api/chats/{chat_id}")).status == 200
    assert (await client.get(f"/api/artifacts/{artifact_id}")).status == 404


async def test_follow_up_replays_the_stored_turn(aiohttp_client, db, fake_llm, tmp_path):
    fake = fake_llm([LLMResponse(tool_calls=[call("list_files")]), LLMResponse(text="Empty."),
                     LLMResponse(text="Still empty.")])
    client = await aiohttp_client(build_app(db))
    body = {"message": {"content": "List"}, "tools": ["files"], "workdir": str(tmp_path), "settings": {"model": "m"}}
    first = sse_events(await (await client.post("/api/chat", json=body)).text())
    body.update(chatId=first[0]["chat_id"], message={"content": "Again"}, tools=[])
    await (await client.post("/api/chat", json=body)).text()
    replayed = fake.requests[2]["messages"]
    assert [m["role"] for m in replayed] == ["system", "user", "assistant", "tool", "assistant", "user"]
    assert fake.requests[2]["tools"] == []
    assert "Turned off now: list_files" in replayed[0]["content"]


async def test_rejects_a_relative_working_folder(aiohttp_client, db):
    client = await aiohttp_client(build_app(db))
    response = await client.post("/api/chat", json={"message": {"content": "x"}, "workdir": "rel/path",
                                                    "settings": {"model": "m"}})
    assert response.status == 400
