"""Model configuration is captured at startup and shared by every endpoint."""

import importlib.util
import json
from pathlib import Path
from unittest.mock import MagicMock

import pytest
from fastapi.testclient import TestClient


@pytest.fixture(params=[False, True], ids=["defaults", "configured"])
def configured_app(request, monkeypatch):
    chat_model = "custom-chat-model" if request.param else "gpt-4o-mini"
    embedding_model = "custom-embedding-model" if request.param else "text-embedding-3-small"
    for name, value in (
        ("OPENAI_CHAT_MODEL", chat_model),
        ("OPENAI_EMBEDDING_MODEL", embedding_model),
    ):
        if request.param:
            monkeypatch.setenv(name, value)
        else:
            monkeypatch.delenv(name, raising=False)

    # Load a fresh module without replacing the app used by other test modules.
    spec = importlib.util.spec_from_file_location(
        "model_config_app", Path(__file__).resolve().parents[1] / "main.py"
    )
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    monkeypatch.setenv("OPENAI_CHAT_MODEL", "changed-after-startup")
    monkeypatch.setenv("OPENAI_EMBEDDING_MODEL", "changed-after-startup")
    return module, chat_model, embedding_model


@pytest.mark.parametrize(
    ("endpoint", "body", "reply"),
    [
        ("/chat", {"message": "Hello", "conversation_id": "conv-1"}, "Hello!"),
        (
            "/transfers/analyse",
            {"amount": 10, "sender": "alice", "recipient": "bob", "memo": "Payment"},
            json.dumps({"flagged": False, "reason": None, "confidence": 0.9}),
        ),
        (
            "/proposals/summarise",
            {"title": "Fund work", "description": "Pay for work", "amount": 10},
            json.dumps({"summary": "Fund the work. Pay the contributor.", "risk": "low"}),
        ),
    ],
)
def test_chat_endpoints_use_startup_model(configured_app, monkeypatch, endpoint, body, reply):
    module, chat_model, _ = configured_app
    openai = MagicMock()
    openai.chat.completions.create.return_value.choices = [
        MagicMock(message=MagicMock(content=reply))
    ]
    monkeypatch.setattr(module, "_openai_client", lambda: openai)

    with TestClient(module.app) as client:
        response = client.post(endpoint, json=body)

    assert response.status_code == 200
    openai.chat.completions.create.assert_called_once()
    assert openai.chat.completions.create.call_args.kwargs["model"] == chat_model


@pytest.mark.parametrize("endpoint", ["/index/message", "/search"])
def test_embedding_endpoints_use_startup_model(configured_app, monkeypatch, endpoint):
    module, _, embedding_model = configured_app
    openai = MagicMock()
    openai.embeddings.create.return_value.data = [MagicMock(embedding=[0.1, 0.2])]
    weaviate = MagicMock()
    weaviate.collections.exists.return_value = True
    weaviate.collections.get.return_value.query.near_vector.return_value.objects = []
    monkeypatch.setattr(module, "_openai_client", lambda: openai)
    monkeypatch.setattr(module.weaviate, "connect_to_local", lambda: weaviate)

    with TestClient(module.app) as client:
        if endpoint == "/search":
            response = client.get(endpoint, params={"q": "hello", "conversationId": "conv-1"})
        else:
            response = client.post(
                endpoint,
                json={
                    "messageId": "msg-1",
                    "conversationId": "conv-1",
                    "senderId": "alice",
                    "content": "hello",
                },
            )

    assert response.status_code == 200
    openai.embeddings.create.assert_called_once_with(input="hello", model=embedding_model)
