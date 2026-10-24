package com.trix.gamebot.bridge.transport;

import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.IdentityHashMap;
import java.util.List;
import java.util.Map;

/**
 * 服务端 NPC 的连接表。每个 agent 至多一条当前连接；同 agent 的新连接替换旧连接。
 * 旧连接的关闭、错误和发送都按代际丢弃，不能拆掉替换后的连接。
 */
public final class AgentConnections {
    public static final int QUEUE_LIMIT = 64;

    public interface Channel {
        boolean isOpen();

        void send(String text);

        void close(int code, String reason);
    }

    public enum Delivery {
        DELIVERED,
        QUEUED,
        DROPPED,
        STALE
    }

    public static final class Binding {
        public final Channel channel;
        public final String agentId;
        public final long generation;

        public Binding(Channel channel, String agentId, long generation) {
            this.channel = channel;
            this.agentId = agentId;
            this.generation = generation;
        }
    }

    private final Object lock = new Object();
    private final Map<Channel, Slot> byChannel = new IdentityHashMap<>();
    private final Map<String, Slot> byAgent = new java.util.LinkedHashMap<>();
    private long nextGeneration;

    public void open(Channel channel) {
        if (channel == null) {
            throw new IllegalArgumentException("channel is required");
        }
        synchronized (lock) {
            byChannel.putIfAbsent(channel, new Slot(channel));
        }
    }

    /**
     * 把一条已打开的连接绑到 agent。同一条连接重复绑定同一个 agent 不换代际。
     * 替换时返回被替换的那一代；没有前一任时返回 null。
     */
    public Binding bind(Channel channel, String agentId) {
        if (channel == null || agentId == null || agentId.isEmpty()) {
            throw new IllegalArgumentException("channel and agent are required");
        }
        synchronized (lock) {
            Slot slot = byChannel.get(channel);
            if (slot == null || slot.stale) {
                throw new IllegalStateException("connection is not open");
            }
            if (slot.agentId != null && !slot.agentId.equals(agentId)) {
                throw new IllegalStateException("connection is already bound to " + slot.agentId);
            }
            Slot current = byAgent.get(agentId);
            if (current == slot) {
                return null;
            }
            long previousGeneration = 0L;
            Channel previousChannel = null;
            if (current != null) {
                previousGeneration = current.generation;
                previousChannel = current.channel;
                current.stale = true;
                current.queue.clear();
            }
            slot.agentId = agentId;
            slot.generation = ++nextGeneration;
            slot.stale = false;
            byAgent.put(agentId, slot);
            if (previousChannel == null) {
                return null;
            }
            return new Binding(previousChannel, agentId, previousGeneration);
        }
    }

    public Binding bindingOf(Channel channel) {
        synchronized (lock) {
            Slot slot = live(channel);
            if (slot == null) {
                return null;
            }
            return slot.binding();
        }
    }

    public Binding bindingOfAgent(String agentId) {
        synchronized (lock) {
            Slot slot = byAgent.get(agentId);
            if (slot == null || slot.stale) {
                return null;
            }
            return slot.binding();
        }
    }

    public List<Binding> bound() {
        synchronized (lock) {
            List<Binding> out = new ArrayList<>();
            for (Slot slot : byAgent.values()) {
                if (!slot.stale && slot.agentId != null) {
                    out.add(slot.binding());
                }
            }
            return out;
        }
    }

    /**
     * 只有当前代际的关闭才摘掉该 agent。被替换的连接返回 null。
     */
    public Binding close(Channel channel) {
        synchronized (lock) {
            Slot slot = byChannel.remove(channel);
            if (slot == null || slot.stale || slot.agentId == null) {
                if (slot != null) {
                    slot.queue.clear();
                }
                return null;
            }
            Slot current = byAgent.get(slot.agentId);
            if (current != slot) {
                slot.queue.clear();
                return null;
            }
            byAgent.remove(slot.agentId);
            Binding binding = slot.binding();
            slot.queue.clear();
            slot.stale = true;
            return binding;
        }
    }

    /** 错误回调不改变归属。过期连接的错误也不能拆掉新连接。 */
    public void onChannelError(Channel channel) {
        synchronized (lock) {
            // 故意不修改 byAgent / byChannel。
            if (channel == null) {
                return;
            }
        }
    }

    public Delivery send(String agentId, long generation, String event, String encoded, boolean droppable) {
        synchronized (lock) {
            Slot slot = byAgent.get(agentId);
            if (slot == null || slot.stale || slot.generation != generation) {
                return Delivery.STALE;
            }
            if (slot.queue.size() >= QUEUE_LIMIT) {
                boolean removed = removeDroppable(slot.queue);
                if (!removed) {
                    if (droppable) {
                        return Delivery.DROPPED;
                    }
                    slot.queue.removeFirst();
                }
            }
            slot.queue.addLast(new Out(encoded, droppable));
            if (!slot.channel.isOpen()) {
                return Delivery.QUEUED;
            }
            flush(slot);
            return Delivery.DELIVERED;
        }
    }

    public int queued(String agentId) {
        synchronized (lock) {
            Slot slot = byAgent.get(agentId);
            return slot == null ? 0 : slot.queue.size();
        }
    }

    private static boolean removeDroppable(ArrayDeque<Out> queue) {
        var iterator = queue.iterator();
        while (iterator.hasNext()) {
            if (iterator.next().droppable) {
                iterator.remove();
                return true;
            }
        }
        return false;
    }

    private static void flush(Slot slot) {
        while (!slot.queue.isEmpty()) {
            slot.channel.send(slot.queue.pollFirst().encoded);
        }
    }

    private Slot live(Channel channel) {
        Slot slot = byChannel.get(channel);
        if (slot == null || slot.stale || slot.agentId == null) {
            return null;
        }
        if (byAgent.get(slot.agentId) != slot) {
            return null;
        }
        return slot;
    }

    private static final class Slot {
        private final Channel channel;
        private final ArrayDeque<Out> queue = new ArrayDeque<>();
        private String agentId;
        private long generation;
        private boolean stale;

        private Slot(Channel channel) {
            this.channel = channel;
        }

        private Binding binding() {
            return new Binding(channel, agentId, generation);
        }
    }

    private static final class Out {
        private final String encoded;
        private final boolean droppable;

        private Out(String encoded, boolean droppable) {
            this.encoded = encoded;
            this.droppable = droppable;
        }
    }
}
