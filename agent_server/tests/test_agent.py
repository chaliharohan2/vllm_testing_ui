import asyncio
import re

from agent_server.agent import close_open_calls, run_turn
from agent_server.llm import LLMResponse

from .conftest import call


async def collect(env, groups, replies_installer, replies, history=None, question="Do it"):
    replies_installer(replies)
    events = []

    async def emit(event):
        events.append(event)

    done = await run_turn(env, groups, "Be brief.", history or [], {"role": "user", "content": question}, emit)
    return done, events


async def test_artifact_placeholder_is_inserted_by_the_server(env, fake_llm):
    replies = [
        LLMResponse(text="Writing it now.", tool_calls=[call("create_artifact", title="Report", type="markdown",
                                                             content="# Report")]),
        LLMResponse(text="Done, see [Report](#artifact/art_fake/1) above."),
    ]
    done, events = await collect(env, ["artifacts"], fake_llm, replies)
    assert done["status"] == "completed"
    row = env.db.messages(env.chat_id)[-1]
    match = re.search(r"\n\n\[Report\]\(#artifact/(art_\w+)/1\)\n\n", row["content"])
    assert match, row["content"]
    assert env.db.get_artifact(match.group(1))["content"] == "# Report"
    # the link the model wrote itself is reduced to its label
    assert row["content"].endswith("Done, see Report above.")
    assert [p["type"] for p in row["parts"]] == ["text", "tool", "text"]
    assert row["llm"][0]["tool_calls"][0]["function"]["name"] == "create_artifact"
    assert row["llm"][-1] == {"role": "assistant", "content": "Done, see [Report](#artifact/art_fake/1) above."}


async def test_turned_off_tool_is_refused_and_named_in_the_prompt(env, fake_llm):
    history = [
        {"role": "user", "content": "weather?"},
        {"role": "assistant", "content": "", "tool_calls": [
            {"id": "c0", "type": "function", "function": {"name": "web_search", "arguments": "{}"}}]},
        {"role": "tool", "tool_call_id": "c0", "content": "sunny"},
        {"role": "assistant", "content": "Sunny."},
    ]
    replies = [LLMResponse(tool_calls=[call("web_search", query="weather")]), LLMResponse(text="It is turned off.")]
    fake = fake_llm(replies)
    events = []

    async def emit(event):
        events.append(event)

    await run_turn(env, ["files"], "", history, {"role": "user", "content": "again"}, emit)
    system = fake.requests[0]["messages"][0]["content"]
    assert "Turned off now: web_search" in system
    assert {t["function"]["name"] for t in fake.requests[0]["tools"]} >= {"read_file", "write_file"}
    tool_message = fake.requests[1]["messages"][-1]
    assert tool_message["role"] == "tool" and "turned off by the user" in tool_message["content"]


async def test_empty_answer_after_tools_gets_one_nudge(env, fake_llm):
    replies = [LLMResponse(tool_calls=[call("list_files")]), LLMResponse(text=""), LLMResponse(text="Two files.")]
    done, _ = await collect(env, ["files"], fake_llm, replies)
    assert done["status"] == "completed"
    assert env.db.messages(env.chat_id)[-1]["content"] == "Two files."


async def test_step_limit_forces_an_answer_without_tools(env, fake_llm):
    env.max_steps = 2
    replies = [LLMResponse(tool_calls=[call("list_files")]),
               lambda messages, tools: LLMResponse(text="Final." if not tools else "?")]
    fake = fake_llm(replies)

    async def emit(_event):
        pass

    done = await run_turn(env, ["files"], "", [], {"role": "user", "content": "go"}, emit)
    assert done["status"] == "completed"
    assert fake.requests[1]["tools"] == []
    assert "No more tool calls" in fake.requests[1]["messages"][-1]["content"]


async def test_subagents_run_in_parallel_and_report_back(env, fake_llm):
    started, release = [], asyncio.Event()

    def sub_reply(name):
        async def gate():
            started.append(name)
            if len(started) == 2:
                release.set()
            await asyncio.wait_for(release.wait(), 2)
        return gate

    gates = {"alpha": sub_reply("alpha"), "beta": sub_reply("beta")}

    def route(messages, tools):
        task = messages[-1]["content"]
        return LLMResponse(text=f"report for {task}")

    replies = [LLMResponse(tool_calls=[call("spawn_subagent", "c1", name="a", task="alpha"),
                                       call("spawn_subagent", "c2", name="b", task="beta")]),
               route, route, LLMResponse(text="Both done.")]
    fake = fake_llm(replies)
    original = fake.__call__

    async def gated(config, messages, tools, on_text, on_reasoning, stop, known_tools=None):
        task = messages[-1]["content"] if messages[-1]["role"] == "user" else ""
        if task in gates:
            await gates[task]()
        return await original(config, messages, tools, on_text, on_reasoning, stop, known_tools)

    import agent_server.agent as agent_module
    agent_module.stream_chat = gated
    try:
        async def emit(_event):
            pass

        done = await run_turn(env, ["subagents", "files", "artifacts"], "", [], {"role": "user", "content": "x"},
                              emit)
    finally:
        agent_module.stream_chat = fake
    assert sorted(started) == ["alpha", "beta"]
    assert done["status"] == "completed"
    sub_tools = {t["function"]["name"] for t in fake.requests[1]["tools"]}
    assert "spawn_subagent" not in sub_tools and "create_artifact" not in sub_tools and "read_file" in sub_tools
    results = [m for m in fake.requests[3]["messages"] if m["role"] == "tool"]
    assert [m["content"] for m in results] == ["Report from subagent 'a':\n\nreport for alpha",
                                               "Report from subagent 'b':\n\nreport for beta"]


async def test_stop_during_a_tool_closes_the_turn_cleanly(env, fake_llm):
    replies = [LLMResponse(text="Running.", tool_calls=[call("run_bash", command="sleep 20")])]
    fake_llm(replies)

    async def emit(event):
        if event["type"] == "tool_start":
            asyncio.get_running_loop().call_later(0.2, env.stop.set)

    done = await run_turn(env, ["bash"], "", [], {"role": "user", "content": "x"}, emit)
    assert done["status"] == "stopped"
    row = env.db.messages(env.chat_id)[-1]
    assert row["parts"][-1]["status"] == "error" and row["parts"][-1]["summary"] == "stopped"
    assert row["llm"][-2]["content"].startswith("Stopped by the user")
    assert row["llm"][-1]["role"] == "assistant"


def test_close_open_calls_answers_every_call():
    messages = [{"role": "assistant", "content": "", "tool_calls": [{"id": "a"}, {"id": "b"}]},
                {"role": "tool", "tool_call_id": "a", "content": "ok"}]
    closed = close_open_calls(messages)
    assert [m.get("tool_call_id") for m in closed if m["role"] == "tool"] == ["a", "b"]
    assert closed[-1]["role"] == "assistant"
