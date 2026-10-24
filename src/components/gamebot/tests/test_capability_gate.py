def test_unknown_action_rejected(client):
    c = client
    c.post("/v1/sessions", json={"game": "fake", "driver": "fake", "session_id": "gate"})
    c.post("/v1/sessions/gate/connect")
    r = c.post("/v1/sessions/gate/actions", json={"action": "explode_world", "params": {}})
    body = r.json()
    assert body["ok"] is False
    assert "unknown action" in (body.get("error") or "")


def test_disabled_capability_is_blocked_before_driver(client):
    c = client
    c.post(
        "/v1/sessions",
        json={
            "game": "fake",
            "driver": "fake",
            "session_id": "limited",
            "config": {"capabilities": ["generic.state.query", "minecraft.chat.say"]},
        },
    )
    c.post("/v1/sessions/limited/connect")
    r = c.post(
        "/v1/sessions/limited/actions",
        json={"action": "move_to", "params": {"x": 1, "y": 64, "z": 1}},
    )
    body = r.json()
    assert body["ok"] is False
    assert body["degraded"] is True
    assert "move_to" in (body.get("degrade_reason") or body.get("error") or "")


def test_query_state_always_allowed(client):
    c = client
    c.post(
        "/v1/sessions",
        json={
            "game": "fake",
            "driver": "fake",
            "session_id": "qs",
            "config": {"capabilities": ["generic.state.query"]},
        },
    )
    r = c.post("/v1/sessions/qs/actions", json={"action": "query_state", "params": {}})
    assert r.json()["ok"] is True
