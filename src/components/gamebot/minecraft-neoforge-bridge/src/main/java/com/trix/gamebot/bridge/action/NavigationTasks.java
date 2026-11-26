package com.trix.gamebot.bridge.action;

import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import com.trix.gamebot.bridge.command.AgentCommands;
import com.trix.gamebot.bridge.entity.AgentEntity;
import com.trix.gamebot.bridge.observation.ServerSnapshotService;
import com.trix.gamebot.bridge.observation.SemanticPerception;
import com.trix.gamebot.bridge.observation.WorldQueries;
import net.minecraft.core.BlockPos;
import net.minecraft.server.MinecraftServer;
import net.minecraft.server.level.ServerLevel;
import net.minecraft.world.entity.Entity;
import net.minecraft.world.phys.Vec3;
import java.util.*;

/** Per-connection navigation ownership. Durations count server ticks, never wall time. */
public final class NavigationTasks {
    public interface Driver {
        Vec3 position(); String dimension(); boolean loaded(Vec3 point); boolean standable(Vec3 point);
        boolean walk(Vec3 point); boolean navigationDone(); void stop(); boolean stopped();
        Vec3 target(JsonObject params); List<Vec3> visibleGoals();
        default void sprint(boolean enabled) {}
    }
    public static final Set<String> ACTIONS = Set.of("navigate_to", "follow_entity", "explore_area", "stop_task");
    private final Map<String, Task> tasks = new HashMap<>();
    private final Map<String, JsonObject> receipts = new LinkedHashMap<>();
    public void clear() { tasks.clear(); receipts.clear(); }

    static final class Task {
        final String id = UUID.randomUUID().toString(), action, dimension;
        final long generation;
        final JsonObject params;
        final Vec3 origin;
        String state = "accepted", phase = "outbound", reason, eventId;
        int ticks, lastProgress, replans, segments;
        Vec3 lastPosition, leg, goal, plannedTarget;
        boolean following;
        final Set<BlockPos> visited = new HashSet<>();
        Task(String action, long generation, JsonObject params, Driver driver) {
            this.action=action; this.generation=generation; this.params=params.deepCopy();
            origin=driver.position(); lastPosition=origin; dimension=driver.dimension();
        }
        boolean active() { return state.equals("accepted") || state.equals("running"); }
        JsonObject view() {
            JsonObject out=new JsonObject(); out.addProperty("task_id",id); out.addProperty("action",action);
            out.addProperty("state",state); out.addProperty("phase",phase); out.addProperty("dimension",dimension);
            out.add("goal", goal == null ? params.deepCopy() : point(goal));
            out.addProperty("elapsed_ticks",ticks); out.addProperty("last_progress_tick",lastProgress);
            out.addProperty("segments",segments); out.addProperty("replans",replans);
            if(reason!=null) out.addProperty("reason",reason);
            if(eventId!=null) out.addProperty("event_id",eventId);
            return out;
        }
    }

    public boolean active(String id) { Task t=tasks.get(id); return t!=null && t.active(); }
    public JsonObject view(String id) { Task t=tasks.get(id); return t==null ? new JsonObject() : t.view(); }
    public String interest(String id) {Task t=tasks.get(id);return t!=null&&t.active()&&t.params.has("interest")?t.params.get("interest").getAsString():null;}
    public ActionOutcome submit(String id, long gen, String request, String action, JsonObject params, Driver driver) {
        String key=id+":"+gen+":"+request;
        if(receipts.containsKey(key)) return ActionOutcome.done(true,"observed",null,null,"accepted",receipts.get(key).deepCopy());
        Task old=tasks.get(id);
        if(old!=null && old.active() && old.generation==gen && old.action.equals(action) && old.params.equals(params)) {
            JsonObject receipt=new JsonObject();receipt.add("task",old.view());receipt.addProperty("already_running",true);remember(key,receipt);
            return ActionOutcome.done(true,"observed",null,null,"already_running",receipt);
        }
        if(action.equals("navigate_to") && driver.position().distanceTo(readPoint(params))<=1.5 && driver.standable(driver.position())) {
            if(old!=null && old.active()) {driver.stop();if(!driver.stopped())return ActionOutcome.failure("busy","waiting for previous navigation to stop");finish(old,"cancelled","replaced",driver);}
            JsonObject receipt=new JsonObject();receipt.add("task",view(id));receipt.addProperty("already_at_goal",true);remember(key,receipt);
            return ActionOutcome.done(true,"confirmed",null,null,"already_at_goal",receipt);
        }
        if(old!=null && old.active()) {
            driver.stop();
            if(!driver.stopped()) return ActionOutcome.failure("busy","waiting for previous navigation to stop");
            finish(old,"cancelled","replaced",driver);
        }
        if(action.equals("stop_task")) {
            driver.stop();
            if(!driver.stopped()) return ActionOutcome.failure("busy","navigation stop not confirmed");
            JsonObject receipt=new JsonObject(); receipt.add("task",view(id)); receipt.addProperty("stopped",true);
            remember(key,receipt);
            return ActionOutcome.done(true,"confirmed",null,null,"stopped",receipt);
        }
        Task t=new Task(action,gen,params,driver); tasks.put(id,t);
        if(action.equals("navigate_to")) t.goal=readPoint(params);
        if(action.equals("explore_area")) t.goal=null;
        JsonObject receipt=new JsonObject(); receipt.add("task",t.view()); remember(key,receipt);
        return ActionOutcome.done(true,"observed",null,null,"accepted",receipt);
    }
    private void remember(String key, JsonObject receipt) {
        receipts.put(key,receipt.deepCopy());
        while(receipts.size()>512) receipts.remove(receipts.keySet().iterator().next());
    }
    public void cancel(String id,long gen,String reason,Driver driver) {
        Task t=tasks.get(id); if(t!=null && t.generation==gen && t.active()) finish(t,"cancelled",reason,driver);
    }
    public void tick(String id, Driver driver) {
        Task t=tasks.get(id); if(t==null || !t.active()) return;
        if(!t.dimension.equals(driver.dimension())) { finish(t,"failed","dimension_changed",driver); return; }
        t.ticks++; t.state="running";
        if(!t.action.equals("follow_entity")) driver.sprint(t.goal!=null && driver.position().distanceTo(t.goal)>=8);
        if(driver.position().distanceTo(t.lastPosition)>=0.2) {
            t.lastProgress=t.ticks; t.lastPosition=driver.position(); t.replans=0;
        }
        if(t.action.equals("navigate_to") && t.ticks>3600) { finish(t,"failed","timeout",driver); return; }
        if(t.action.equals("follow_entity")) {
            if(t.ticks%10!=1) return;
            Vec3 target=driver.target(t.params);
            if(target==null) { finish(t,"failed","target_lost",driver); return; }
            double distance=driver.position().distanceTo(target);
            driver.sprint(distance>=8);
            double keep=t.params.has("distance")?t.params.get("distance").getAsDouble():3;
            if(distance<=keep) { driver.stop(); t.following=false; t.leg=null; t.lastProgress=t.ticks; t.phase="holding"; return; }
            if(!t.following && distance<=keep+2) { t.lastProgress=t.ticks; return; }
            t.following=true; t.phase="following"; t.goal=target;
            if(t.plannedTarget!=null && target.distanceTo(t.plannedTarget)<=2 && !driver.navigationDone() && t.ticks-t.lastProgress<100) return;
            t.plannedTarget=target;
        }
        if(t.action.equals("explore_area")) {
            int duration=(t.params.has("seconds")?t.params.get("seconds").getAsInt():120)*20;
            if(t.ticks>=duration && !t.phase.equals("returning")) {
                if(!t.params.has("return_to_start") || t.params.get("return_to_start").getAsBoolean()) {
                    t.phase="returning"; t.goal=t.origin; driver.stop(); t.leg=null;
                } else { finish(t,"completed",null,driver); return; }
            }
            if(!t.phase.equals("returning") && (t.goal==null || driver.position().distanceTo(t.goal)<=1.5)) {
                Vec3 center=t.params.has("center")?readPoint(t.params.getAsJsonObject("center")):t.origin;
                double radius=t.params.has("radius")?t.params.get("radius").getAsDouble():16;
                t.goal=driver.visibleGoals().stream().filter(p->p.distanceTo(center)<=radius && !t.visited.contains(BlockPos.containing(p)))
                        .min(Comparator.comparingDouble(p->p.distanceToSqr(driver.position()))).orElse(null);
                if(t.goal==null) {
                    if(!t.params.has("return_to_start")||t.params.get("return_to_start").getAsBoolean()) {t.phase="returning";t.goal=t.origin;}
                    else {finish(t,"completed","visible_area_exhausted",driver);return;}
                } else t.visited.add(BlockPos.containing(t.goal));
                t.leg=null;
            }
            if(t.ticks>duration+3600) { finish(t,"failed","return_timeout",driver); return; }
        }
        if(t.goal==null) { finish(t,"failed","missing_goal",driver); return; }
        if(!driver.loaded(t.goal)) { finish(t,"failed","target_chunk_unloaded",driver); return; }
        double tolerance=t.phase.equals("returning")?2:1.5;
        if(!t.action.equals("follow_entity") && driver.position().distanceTo(t.goal)<=tolerance && driver.standable(driver.position())) {
            if(t.action.equals("explore_area") && !t.phase.equals("returning")) { t.goal=null; t.leg=null; return; }
            finish(t,"completed",null,driver); return;
        }
        boolean stuck=t.ticks-t.lastProgress>=100;
        if(t.leg!=null && !driver.navigationDone() && !stuck && !t.action.equals("follow_entity")) return;
        if(stuck || (t.leg!=null && driver.navigationDone() && driver.position().distanceTo(t.leg)>1.5)) {
            if(++t.replans>3) { finish(t,"failed","blocked",driver); return; }
            t.lastProgress=t.ticks;
        }
        Vec3 delta=t.goal.subtract(driver.position());
        Vec3 leg=delta.length()>16?driver.position().add(delta.normalize().scale(16)):t.goal;
        if(!driver.loaded(leg)) { finish(t,"failed","segment_chunk_unloaded",driver); return; }
        if(!driver.standable(leg)) {
            Vec3 desired=leg;
            leg=driver.visibleGoals().stream().filter(p->p.distanceTo(driver.position())<=16 && p.distanceTo(t.goal)<driver.position().distanceTo(t.goal)-0.25)
                    .min(Comparator.comparingDouble(p->p.distanceToSqr(desired))).orElse(null);
        }
        if(leg==null || !driver.walk(leg)) {
            if(++t.replans>3) finish(t,"failed","no_reachable_segment",driver);
            t.lastProgress=t.ticks; t.leg=null;
            return;
        }
        t.leg=leg; t.segments++; t.phase=t.action.equals("follow_entity")?"following":t.phase;
    }
    private static void finish(Task t,String state,String reason,Driver driver) {
        if(driver!=null) { driver.sprint(false); driver.stop(); } t.state=state; t.reason=reason; t.eventId=t.id+":"+state;
    }
    public void tick(MinecraftServer server) {
        for(var entry:tasks.entrySet()) if(entry.getValue().active()) {
            AgentEntity agent=AgentCommands.find(server,entry.getKey());
            if(agent==null || !agent.isAlive()) finish(entry.getValue(),"failed","agent_unavailable",null);
            else tick(entry.getKey(),driver(server,agent));
        }
    }
    public void cancelAll(MinecraftServer server,String reason) {
        for(var e:tasks.entrySet()) { AgentEntity a=server==null?null:AgentCommands.find(server,e.getKey());
            if(e.getValue().active()) finish(e.getValue(),"cancelled",reason,a==null?null:driver(server,a)); }
    }
    public void cancel(MinecraftServer server,String id,long gen,String reason) {
        AgentEntity a=server==null?null:AgentCommands.find(server,id);
        cancel(id,gen,reason,a==null?null:driver(server,a));
    }
    public static Driver driver(MinecraftServer server,AgentEntity agent) {
        return new Driver() {
            public Vec3 position(){return agent.position();}
            public String dimension(){return agent.level().dimension().location().toString();}
            public boolean loaded(Vec3 p){return WorldQueries.chunkLoaded(agent.level(),BlockPos.containing(p));}
            public boolean standable(Vec3 p){return MovementGeometry.canStandAt((ServerLevel)agent.level(),agent,p.x,p.y,p.z);}
            public boolean walk(Vec3 p){
                var nav=agent.getNavigation(); var path=nav.createPath(p.x,p.y,p.z,1);
                if(path==null || !path.canReach()) return false;
                return nav.moveTo(path,1.0);
            }
            public boolean navigationDone(){return agent.getNavigation().isDone();}
            public void sprint(boolean enabled){agent.setSprinting(enabled && agent.onGround() && !agent.isInWater() && !agent.isInLava() && !agent.isShiftKeyDown() && !agent.horizontalCollision);}
            public void stop(){agent.setSprinting(false); agent.getNavigation().stop(); agent.setDeltaMovement(Vec3.ZERO);}
            public boolean stopped(){return agent.getNavigation().isDone() && agent.getDeltaMovement().horizontalDistanceSqr()<0.0001;}
            public Vec3 target(JsonObject p){
                Entity target=null;
                if(p.has("uuid")) { try{target=server.getPlayerList().getPlayer(UUID.fromString(p.get("uuid").getAsString()));}catch(IllegalArgumentException ignored){} }
                else if(p.has("target_agent_id")) target=AgentCommands.find(server,p.get("target_agent_id").getAsString());
                return target!=null && target.isAlive() && target.level()==agent.level()?target.position():null;
            }
            public List<Vec3> visibleGoals(){
                JsonArray blocks=ServerSnapshotService.nearbyBlocks(agent,8);
                List<Vec3> out=new ArrayList<>();
                for(var e:blocks) {var pos=e.getAsJsonObject().getAsJsonObject("pos"); BlockPos b=new BlockPos(pos.get("x").getAsInt(),pos.get("y").getAsInt(),pos.get("z").getAsInt());
                    if(!SemanticPerception.visible(agent,b)) continue;
                    Vec3 feet=MovementGeometry.standingSurface((ServerLevel)agent.level(),agent,b);
                    if(feet!=null && feet.distanceTo(agent.position())>=2 && feet.distanceTo(agent.position())<=16) out.add(feet);
                } return out;
            }
        };
    }
    static Vec3 readPoint(JsonObject p){return new Vec3(p.get("x").getAsDouble(),p.get("y").getAsDouble(),p.get("z").getAsDouble());}
    static JsonObject point(Vec3 p){JsonObject o=new JsonObject();o.addProperty("x",p.x);o.addProperty("y",p.y);o.addProperty("z",p.z);return o;}
}
