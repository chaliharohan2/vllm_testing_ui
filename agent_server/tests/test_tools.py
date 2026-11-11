import asyncio

import pytest

from agent_server.tools import bash, files
from agent_server.tools.artifacts import create_artifact, update_artifact
from agent_server.tools.base import ToolError


async def test_file_tools_create_edit_read_and_delete(ctx):
    await files.write_file(ctx, {"path": "src/app.py", "content": "x = 1\ny = 2\n"})
    result = await files.edit_file(ctx, {"path": "src/app.py", "old_string": "y = 2", "new_string": "y = 3"})
    assert result.ok and (ctx.workdir / "src/app.py").read_text() == "x = 1\ny = 3\n"
    read = await files.read_file(ctx, {"path": "src/app.py"})
    assert "     2|y = 3" in read.content
    listing = await files.list_files(ctx, {})
    assert "src/" in listing.content and "app.py" in listing.content
    with pytest.raises(ToolError, match="not empty"):
        await files.delete_file(ctx, {"path": "src"})
    await files.delete_file(ctx, {"path": "src", "recursive": True})
    assert not (ctx.workdir / "src").exists()


async def test_file_tools_stay_inside_the_working_folder(ctx):
    with pytest.raises(ToolError, match="outside the working folder"):
        await files.write_file(ctx, {"path": "../escape.txt", "content": "no"})
    with pytest.raises(ToolError, match="outside the working folder"):
        await files.read_file(ctx, {"path": "/etc/passwd"})
    with pytest.raises(ToolError, match="working folder itself"):
        await files.delete_file(ctx, {"path": ".", "recursive": True})


async def test_edit_needs_a_unique_match(ctx):
    await files.write_file(ctx, {"path": "a.txt", "content": "same\nsame\n"})
    with pytest.raises(ToolError, match="2 times"):
        await files.edit_file(ctx, {"path": "a.txt", "old_string": "same", "new_string": "new"})
    result = await files.edit_file(ctx, {"path": "a.txt", "old_string": "same", "new_string": "new",
                                         "replace_all": True})
    assert "2 replacements" in result.content


async def test_bash_runs_in_the_working_folder(ctx):
    result = await bash.run_bash(ctx, {"command": "pwd && echo hi && exit 3"})
    assert result.content.startswith("Exit code: 3")
    assert str(ctx.workdir) in result.content and "hi" in result.content
    assert not result.ok


async def test_bash_timeout_kills_the_command(ctx):
    result = await bash.run_bash(ctx, {"command": "sleep 30", "timeout_seconds": 1})
    assert "Timed out after 1s" in result.content


def test_privilege_detection():
    assert bash.needs_sudo("sudo apt install x")
    assert bash.needs_sudo("cd /tmp && sudo -n true")
    assert bash.needs_sudo("echo $(sudo whoami)")
    assert not bash.needs_sudo("echo pseudocode; ls sudoers.d")
    assert bash.other_elevation("su - root") == "su"
    assert bash.other_elevation("pkexec ls") == "pkexec"
    assert bash.other_elevation("echo summary; ls /usr") is None


async def test_sudo_waits_for_the_user_and_can_be_denied(ctx):
    task = asyncio.create_task(bash.run_bash(ctx, {"command": "sudo whoami", "reason": "check"}))
    for _ in range(50):
        await asyncio.sleep(0.01)
        if ctx.events:
            break
    request = ctx.events[0]
    assert request["type"] == "permission" and request["command"] == "sudo whoami"
    assert ctx.permissions.resolve(request["request_id"], False, None)
    result = await task
    assert not result.ok and "did not allow" in result.content
    assert ctx.events[-1] == {"type": "permission_resolved", "request_id": request["request_id"],
                              "approved": False, "tool_call_id": "call_1"}


async def test_other_elevation_is_refused(ctx):
    with pytest.raises(ToolError, match="not allowed"):
        await bash.run_bash(ctx, {"command": "su -c whoami"})


async def test_artifacts_are_versioned_with_placeholders(ctx):
    created = await create_artifact(ctx, {"title": "Plan", "type": "markdown", "content": "# Plan\n\nStep one"})
    artifact_id = created.content.split()[2]
    assert created.placeholder == f"[Plan](#artifact/{artifact_id}/1)"
    updated = await update_artifact(ctx, {"artifact_id": artifact_id, "old_string": "one", "new_string": "two"})
    assert updated.placeholder == f"[Plan](#artifact/{artifact_id}/2)"
    assert ctx.db.get_artifact(artifact_id)["content"] == "# Plan\n\nStep two"
    assert ctx.db.get_artifact(artifact_id, 1)["content"] == "# Plan\n\nStep one"
    with pytest.raises(ToolError, match="no artifact"):
        await update_artifact(ctx, {"artifact_id": "art_missing", "content": "x"})
