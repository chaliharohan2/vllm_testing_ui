from agent_server.text_filters import PlaceholderFilter, ToolCallTextFilter, placeholder_link
from agent_server.toolcall_parse import extract_tool_calls


def feed_all(text_filter, chunks):
    return "".join(text_filter.feed(chunk) for chunk in chunks) + text_filter.flush()


def test_placeholder_filter_strips_links_the_model_writes_across_chunks():
    chunks = ["See [My ", "doc](#arti", "fact/art_1/1) and [a link](https://x.io)."]
    assert feed_all(PlaceholderFilter(), chunks) == "See My doc and [a link](https://x.io)."


def test_placeholder_filter_keeps_plain_brackets():
    assert feed_all(PlaceholderFilter(), ["list[0] ", "and [x]"]) == "list[0] and [x]"


def test_placeholder_link_cleans_the_label():
    assert placeholder_link("art_1", 2, "A [draft]\nplan") == "[A draft plan](#artifact/art_1/2)"


def test_tool_call_text_is_hidden_from_the_stream():
    chunks = ["Let me check.", "<tool", "_call>{\"name\": \"web_search\"}", "</tool_call>"]
    assert feed_all(ToolCallTextFilter(), chunks) == "Let me check."
    assert feed_all(ToolCallTextFilter(), ["a <b>", " c"]) == "a <b> c"


def test_xml_tool_call_in_text_is_recovered():
    text = "<tool_call>\n<function=run_bash>\n<parameter=command>\nls -la\n</parameter>\n</function>\n</tool_call>"
    calls, rest = extract_tool_calls(text, {"run_bash"})
    assert [(c.name, c.arguments) for c in calls] == [("run_bash", {"command": "ls -la"})]
    assert rest == ""
