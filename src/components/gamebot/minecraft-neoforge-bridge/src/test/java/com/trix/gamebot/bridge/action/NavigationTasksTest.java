package com.trix.gamebot.bridge.action;

import com.google.gson.JsonObject;
import net.minecraft.world.phys.Vec3;
import org.junit.jupiter.api.Test;
import java.util.*;
import static org.junit.jupiter.api.Assertions.*;

class NavigationTasksTest {
    static final class Driver implements NavigationTasks.Driver {
        Vec3 pos=Vec3.ZERO, target=new Vec3(12,0,0), leg;
        boolean done=true, loaded=true, stopped=true, canWalk=true, sprinting;
        String dimension="overworld";
        List<Vec3> walks=new ArrayList<>(), goals=new ArrayList<>();
        public Vec3 position(){return pos;} public String dimension(){return dimension;}
        public boolean loaded(Vec3 p){return loaded;} public boolean standable(Vec3 p){return true;}
        public boolean walk(Vec3 p){walks.add(p);leg=p;done=false;stopped=false;return canWalk;}
        public boolean navigationDone(){return done;} public void stop(){done=true;stopped=true;}
        public boolean stopped(){return stopped;} public Vec3 target(JsonObject p){return target;}
        public List<Vec3> visibleGoals(){return goals;}
        public void sprint(boolean enabled){sprinting=enabled;}
        void arrive(){pos=leg;done=true;}
    }
    static JsonObject point(double x){JsonObject p=new JsonObject();p.addProperty("x",x);p.addProperty("y",0);p.addProperty("z",0);return p;}
    @Test void distantNavigationAndFollowSprintButApproachAndCancellationDoNot() {
        var tasks=new NavigationTasks();var d=new Driver();
        tasks.submit("g",1,"r","navigate_to",point(24),d);tasks.tick("g",d);assertTrue(d.sprinting);
        d.pos=new Vec3(20,0,0);tasks.tick("g",d);assertFalse(d.sprinting);
        var p=new JsonObject();p.addProperty("uuid","player");d.target=new Vec3(40,0,0);
        tasks.submit("g",1,"follow","follow_entity",p,d);tasks.tick("g",d);assertTrue(d.sprinting);
        d.target=d.pos.add(2,0,0);for(int i=0;i<10;i++)tasks.tick("g",d);assertFalse(d.sprinting);
        d.target=d.pos.add(20,0,0);for(int i=0;i<10;i++)tasks.tick("g",d);assertTrue(d.sprinting);
        tasks.cancel("g",1,"disabled",d);assertFalse(d.sprinting);assertTrue(d.stopped);
    }
    @Test void oneRequestCrossesManySegmentsAndOnlyFinalArrivalCompletes() {
        var tasks=new NavigationTasks();var d=new Driver();
        var receipt=tasks.submit("g",1,"r","navigate_to",point(120),d);
        assertEquals("accepted",receipt.evidence.getAsJsonObject("task").get("state").getAsString());
        double previous=0;
        for(int n=0;n<12&&tasks.active("g");n++) {
            tasks.tick("g",d);
            if(!d.done){assertTrue(d.leg.distanceTo(d.pos)<=16.000001);assertTrue(d.leg.x>previous);previous=d.leg.x;d.arrive();}
        }
        assertEquals("completed",tasks.view("g").get("state").getAsString());
        assertTrue(d.walks.size()>=8);
        String event=tasks.view("g").get("event_id").getAsString();tasks.tick("g",d);
        assertEquals(event,tasks.view("g").get("event_id").getAsString());
    }
    @Test void followHysteresisTargetLossAndIndependentSeats() {
        var tasks=new NavigationTasks();var d=new Driver();var p=new JsonObject();p.addProperty("uuid","player");
        tasks.submit("g",1,"r","follow_entity",p,d);tasks.submit("other",1,"r","navigate_to",point(20),new Driver());
        tasks.tick("g",d);assertEquals(1,d.walks.size());d.arrive();
        for(int i=0;i<10;i++)tasks.tick("g",d);assertTrue(d.stopped);assertTrue(tasks.active("g"));
        d.target=d.pos.add(4,0,0);for(int i=0;i<10;i++)tasks.tick("g",d);assertEquals(1,d.walks.size());
        d.target=d.pos.add(6,0,0);for(int i=0;i<10;i++)tasks.tick("g",d);assertEquals(2,d.walks.size());
        d.target=null;for(int i=0;i<10;i++)tasks.tick("g",d);
        assertEquals("target_lost",tasks.view("g").get("reason").getAsString());assertTrue(tasks.active("other"));
    }
    @Test void cancellationGenerationDuplicatesAndReplacementOwnOneNavigator() {
        var tasks=new NavigationTasks();var d=new Driver();
        var first=tasks.submit("g",1,"r","navigate_to",point(30),d);tasks.tick("g",d);
        var duplicate=tasks.submit("g",1,"r","navigate_to",point(30),d);
        assertEquals(first.evidence,duplicate.evidence);assertEquals(1,d.walks.size());
        tasks.submit("g",2,"new","navigate_to",point(40),d);tasks.cancel("g",1,"old",d);
        assertTrue(tasks.active("g"));tasks.cancel("g",2,"manual",d);assertFalse(tasks.active("g"));assertTrue(d.stopped);
        var stop=tasks.submit("g",2,"stop","stop_task",new JsonObject(),d);assertTrue(stop.evidence.get("stopped").getAsBoolean());
    }
    @Test void noTicksMeanNoElapsedTimeAndStuckWorkEventuallyFails() {
        var tasks=new NavigationTasks();var d=new Driver();tasks.submit("g",1,"r","navigate_to",point(30),d);
        tasks.tick("g",d);int elapsed=tasks.view("g").get("elapsed_ticks").getAsInt();
        for(int i=0;i<100;i++)tasks.view("g");assertEquals(elapsed,tasks.view("g").get("elapsed_ticks").getAsInt());
        for(int i=0;i<500;i++)tasks.tick("g",d);
        assertEquals("blocked",tasks.view("g").get("reason").getAsString());
    }
    @Test void repeatedTaskDoesNotRestartAndAlreadyArrivedRequestsDoNotEmitNewTerminals() {
        var tasks=new NavigationTasks();var d=new Driver();tasks.submit("g",1,"r","navigate_to",point(30),d);
        String id=tasks.view("g").get("task_id").getAsString();
        var repeated=tasks.submit("g",1,"r2","navigate_to",point(30),d);
        assertTrue(repeated.evidence.get("already_running").getAsBoolean());assertEquals(id,tasks.view("g").get("task_id").getAsString());
        d.pos=new Vec3(30,0,0);tasks.tick("g",d);String event=tasks.view("g").get("event_id").getAsString();
        var arrived=tasks.submit("g",1,"r3","navigate_to",point(30),d);
        assertTrue(arrived.evidence.get("already_at_goal").getAsBoolean());assertEquals(event,tasks.view("g").get("event_id").getAsString());
    }
    @Test void unloadedGoalAndDimensionChangesStopWithoutWalking() {
        for(boolean unloaded:new boolean[]{true,false}) {
            var tasks=new NavigationTasks();var d=new Driver();tasks.submit("g",1,"r","navigate_to",point(30),d);
            if(unloaded)d.loaded=false;else d.dimension="nether";tasks.tick("g",d);
            assertFalse(tasks.active("g"));assertTrue(d.walks.isEmpty());assertTrue(d.stopped);
        }
    }
    @Test void explorationVisitsNewPointsAndReturnsBeforeCompleting() {
        var tasks=new NavigationTasks();var d=new Driver();d.goals=List.of(new Vec3(3,0,0),new Vec3(6,0,0));
        JsonObject p=new JsonObject();p.addProperty("seconds",1);p.addProperty("return_to_start",true);
        tasks.submit("g",1,"r","explore_area",p,d);
        for(int i=0;i<40&&tasks.active("g");i++){tasks.tick("g",d);if(!d.done)d.arrive();}
        assertEquals("completed",tasks.view("g").get("state").getAsString());assertTrue(d.pos.distanceTo(Vec3.ZERO)<=2);
    }
}
