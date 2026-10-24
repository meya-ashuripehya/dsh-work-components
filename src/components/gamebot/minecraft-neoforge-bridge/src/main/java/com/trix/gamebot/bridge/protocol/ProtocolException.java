package com.trix.gamebot.bridge.protocol;

public final class ProtocolException extends Exception {
    public final String code;

    public ProtocolException(String code, String message) {
        super(message);
        this.code = code;
    }
}
