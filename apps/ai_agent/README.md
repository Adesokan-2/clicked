# AI Agent

## OpenAI configuration

Set these environment variables before starting the service:

| Variable | Default | Used by |
| --- | --- | --- |
| `OPENAI_API_KEY` | Required | All OpenAI requests |
| `OPENAI_CHAT_MODEL` | `gpt-4o-mini` | `/chat`, `/transfers/analyse`, `/proposals/summarise` |
| `OPENAI_EMBEDDING_MODEL` | `text-embedding-3-small` | `/index/message`, `/search` |

Model settings are read once when the application module loads at startup.
Restart the service after changing either model variable. When changing the
embedding model, ensure existing indexed vectors are compatible or reindex the
messages with the new model before searching them.
