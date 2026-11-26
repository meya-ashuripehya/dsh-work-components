"""Validate real protocol boundaries without credentials or network access."""
import importlib.util
from pathlib import Path
import unittest

spec = importlib.util.spec_from_file_location("mc_live_model", Path(__file__).with_name("mc-live-model.py"))
adapter = importlib.util.module_from_spec(spec)
spec.loader.exec_module(adapter)


class VertexDecisionTest(unittest.TestCase):
    def test_advertised_tools_and_prompt_are_preserved(self):
        request = {"prompt": {"system": "persona", "messages": [{"role": "user", "content": "fresh observation"}]}, "tools": [{"name": "wait", "parameters": {"type": "object", "properties": {"seconds": {"type": "number"}}}}]}
        body = adapter.vertex_body(request)
        self.assertEqual(body["contents"][0]["parts"][0]["text"], "fresh observation")
        self.assertEqual(body["tools"][0]["functionDeclarations"][0]["name"], "wait")
        self.assertNotIn("api_key", body)

    def test_thought_is_not_speech_and_tools_survive(self):
        result = adapter.vertex_result({"candidates": [{"finishReason": "STOP", "content": {"parts": [{"text": "secret reasoning", "thought": True}, {"functionCall": {"name": "say", "args": {"text": "hello"}}}]}}]})
        self.assertEqual(result["text"], "")
        self.assertEqual(result["toolCalls"], [{"name": "say", "arguments": {"text": "hello"}}])
        self.assertIsNone(result["usage"]["input"])

    def test_usage_keeps_actual_provider_counts(self):
        result = adapter.vertex_result({"usageMetadata": {"promptTokenCount": 123, "candidatesTokenCount": 7}, "candidates": [{"finishReason": "STOP", "content": {"parts": [{"text": "goal"}]}}]})
        self.assertEqual(result["usage"]["input"], 123)
        self.assertEqual(result["usage"]["output"], 7)

    def test_partial_or_blocked_decision_is_never_executed(self):
        for payload in ({}, {"candidates": [{"finishReason": "MAX_TOKENS", "content": {"parts": [{"functionCall": {"name": "move_to"}}]}}]}, {"candidates": [{"finishReason": "STOP", "content": {"parts": []}}]}):
            with self.assertRaises(ValueError):
                adapter.vertex_result(payload)


if __name__ == "__main__":
    unittest.main()
