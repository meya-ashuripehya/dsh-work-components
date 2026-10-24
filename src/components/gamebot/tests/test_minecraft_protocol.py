from gamebot.adapters.minecraft.protocol import apply_presence_event, extract_handshake, parse_incoming_chat


def test_parse_event_chat():
    player, text = parse_incoming_chat({"event": "chat", "player": "Steve", "message": "hello"}, "Shiro")
    assert player == "Steve"
    assert text == "hello"


def test_parse_minaret_user_message_without_event():
    player, text = parse_incoming_chat({"user": "Alex", "message": "yo"}, "Shiro")
    assert player == "Alex"
    assert text == "yo"


def test_ignore_bot_self_chat():
    assert parse_incoming_chat({"user": "Shiro", "message": "self"}, "Shiro") is None


def test_player_join_leave():
    online = set()
    apply_presence_event({"event": "player_join", "player": "Steve"}, online)
    assert "Steve" in online
    apply_presence_event({"type": "player_leave", "user": "Steve"}, online)
    assert "Steve" not in online


def test_handshake_version_loader_mods():
    hs = extract_handshake(
        {
            "event": "hello",
            "version": "1.21.1",
            "loader": "NeoForge",
            "mods": ["create", "ae2", "jei"],
            "position": {"x": 1, "y": 64, "z": -3},
            "health": 18,
        }
    )
    assert hs["version"] == "1.21.1"
    assert hs["loader"] == "neoforge"
    assert "create" in hs["mods"]
    assert hs["position"]["y"] == 64.0
    assert hs["health"] == 18.0
