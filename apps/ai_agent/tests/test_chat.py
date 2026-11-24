"""Unit tests for POST /chat (issue #144)."""

from unittest.mock import MagicMock

import httpx
import pytest
from openai import APIError, APITimeoutError

_BASE_BODY = {
    "message": "What is Clicked?",
    "conversation_id": "conv-123",
}


def _fake_chat_reply(content: str | None = "This is a test reply."):
    msg = MagicMock()
    msg.content = content
    choice = MagicMock()
    choice.message = msg
    resp = MagicMock()
    resp.choices = [choice]
    return resp


def test_missing_api_key_returns_500(monkeypatch, client):
    monkeypatch.delenv("OPENAI_API_KEY", raising=False)
    response = client.post("/chat", json=_BASE_BODY)
    assert response.status_code == 500


def test_valid_request_returns_reply(mock_openai, client):
    mock_client = mock_openai.return_value
    mock_client.chat.completions.create.return_value = _fake_chat_reply("Hello from Clicked AI!")

    response = client.post("/chat", json=_BASE_BODY)
    assert response.status_code == 200
    data = response.json()
    assert "reply" in data
    assert data["reply"] == "Hello from Clicked AI!"


def test_system_prompt_contains_context(mock_openai, client):
    mock_client = mock_openai.return_value
    mock_client.chat.completions.create.return_value = _fake_chat_reply("Sure, I can help!")

    response = client.post("/chat", json=_BASE_BODY)
    assert response.status_code == 200

    call_args = mock_client.chat.completions.create.call_args
    messages = call_args[1]["messages"]
    system_msg = messages[0]
    assert system_msg["role"] == "system"
    content = system_msg["content"]
    assert "Clicked" in content
    assert "Stellar" in content
    assert "messaging" in content or "payment" in content


def test_missing_message_returns_422(client):
    body = {"conversation_id": "conv-123"}
    response = client.post("/chat", json=body)
    assert response.status_code == 422


def test_missing_conversation_id_returns_422(client):
    body = {"message": "Hello"}
    response = client.post("/chat", json=body)
    assert response.status_code == 422


def test_correct_model_used(mock_openai, client):
    mock_client = mock_openai.return_value
    mock_client.chat.completions.create.return_value = _fake_chat_reply("OK")

    client.post("/chat", json=_BASE_BODY)

    call_args = mock_client.chat.completions.create.call_args
    assert call_args[1]["model"] == "gpt-4o-mini"


@pytest.mark.parametrize("content", [None, "   "])
def test_empty_reply_returns_502(mock_openai, client, content):
    mock_client = mock_openai.return_value
    mock_client.chat.completions.create.return_value = _fake_chat_reply(content)

    response = client.post("/chat", json=_BASE_BODY)

    assert response.status_code == 502
    assert response.json()["detail"] == "LLM did not return a reply"


def test_timeout_returns_504(mock_openai, client):
    request = httpx.Request("POST", "https://api.openai.com/v1/chat/completions")
    mock_client = mock_openai.return_value
    mock_client.chat.completions.create.side_effect = APITimeoutError(request)

    response = client.post("/chat", json=_BASE_BODY)

    assert response.status_code == 504
    assert response.json()["detail"] == "OpenAI request timed out"


def test_api_error_returns_502(mock_openai, client):
    request = httpx.Request("POST", "https://api.openai.com/v1/chat/completions")
    mock_client = mock_openai.return_value
    mock_client.chat.completions.create.side_effect = APIError(
        "service unavailable", request=request, body=None
    )

    response = client.post("/chat", json=_BASE_BODY)

    assert response.status_code == 502
    assert response.json()["detail"] == "OpenAI API error"
