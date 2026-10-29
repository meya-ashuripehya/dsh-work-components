"""Chat must survive snapshot flood in recent_events for mirror/re-arm."""
from gamebot.adapters.minecraft.minaret import MinaretBackend


def test_slim_snapshots_and_prefer_chat_in_observe_window():
    backend = MinaretBackend({})
    for i in range(20):
        backend._push({"type": "snapshot", "data": {"sequence": i, "data": {"huge": "x" * 1000}}, "at": float(i)})
    backend._push({
        "type": "chat",
        "data": {
            "event": "chat",
            "sequence": 99,
            "data": {
                "source": "agent",
                "say_id": "abc",
                "message_id": "abc",
                "message": "hi",
                "player": "GPT",
                "audience": "public",
            },
        },
        "at": 100.0,
    })
    for i in range(20, 40):
        backend._push({"type": "snapshot", "data": {"sequence": i, "data": {"huge": "y" * 1000}}, "at": float(i)})

    # buffer kept chat despite many snapshots
    assert any(item.get("type") == "chat" for item in backend._recent_events)
    # slim snapshots have no bulky data blob
    snaps = [item for item in backend._recent_events if item.get("type") == "snapshot"]
    assert snaps
    assert all("data" not in item or not isinstance(item.get("data"), dict) for item in snaps)
    assert all(item.get("sequence") is not None for item in snaps)

    recent = backend.snapshot_fields()["recent_events"]
    assert any(item.get("type") == "chat" for item in recent)
    chat = next(item for item in recent if item.get("type") == "chat")
    assert chat["data"]["data"]["say_id"] == "abc"
