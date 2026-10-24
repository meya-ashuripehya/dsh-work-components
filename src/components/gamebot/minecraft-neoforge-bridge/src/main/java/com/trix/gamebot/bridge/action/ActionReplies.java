package com.trix.gamebot.bridge.action;

import com.google.gson.JsonObject;

/** 动作结果只送回提交它的那一代连接。 */
public interface ActionReplies {
    long nextSequence();

    void send(String agentId, long generation, JsonObject payload);
}
