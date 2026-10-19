import json
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from tests.runtime_helpers import make_opencode_server


async def opencode_config_for(provider: str, model: str, tmp_path) -> dict:
    session_config = json.dumps({"provider": provider, "model": model})
    server = make_opencode_server({"SESSION_CONFIG": session_config}, workspace_path=tmp_path)
    with (
        patch.object(server, "_setup_managed_oauth"),
        patch.object(server, "_prepare_opencode_filesystem", return_value=set()),
        patch.object(server, "_wait_for_health", new_callable=AsyncMock),
        patch(
            "sandbox_runtime.opencode_server.asyncio.create_subprocess_exec",
            new_callable=AsyncMock,
            return_value=MagicMock(stdout=None),
        ) as spawn,
        patch(
            "sandbox_runtime.opencode_server.asyncio.create_task",
            side_effect=lambda coro: coro.close(),
        ),
    ):
        await server.start((), tmp_path)
    return json.loads(spawn.call_args.kwargs["env"]["OPENCODE_CONFIG_CONTENT"])


@pytest.mark.parametrize(
    ("provider", "model", "expected"),
    [
        ("openai", "gpt-5.6-sol", "openai/gpt-5.6-terra"),
        ("anthropic", "claude-opus-5-5", "anthropic/claude-sonnet-5-5"),
        ("xai", "grok-4.7", "xai/grok-4.7"),
    ],
)
async def test_mid_subagent_runs_on_the_providers_mid_tier(provider, model, expected, tmp_path):
    config = await opencode_config_for(provider, model, tmp_path)

    assert config["agent"]["mid"]["mode"] == "subagent"
    assert config["agent"]["mid"]["model"] == expected
