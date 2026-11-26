package com.trix.gamebot.bridge.observation;

import com.trix.gamebot.bridge.entity.AgentEntity;
import net.minecraft.SharedConstants;
import net.minecraft.core.BlockPos;
import net.minecraft.core.Direction;
import net.minecraft.server.Bootstrap;
import net.minecraft.server.level.ServerLevel;
import net.minecraft.world.level.ClipContext;
import net.minecraft.world.level.block.Blocks;
import net.minecraft.world.level.block.state.properties.BlockStateProperties;
import com.google.gson.JsonObject;
import net.minecraft.world.phys.BlockHitResult;
import net.minecraft.world.phys.Vec3;
import org.junit.jupiter.api.*;
import java.util.*;
import static org.junit.jupiter.api.Assertions.*;
import static org.mockito.Mockito.*;
import static org.mockito.ArgumentMatchers.*;

class SemanticPerceptionTest {
    @BeforeAll static void boot(){SharedConstants.tryDetectVersion();Bootstrap.bootStrap();}
    @Test void statePropertiesHaveActualBooleanNumberAndEnumTypes() {
        var candle=SemanticPerception.stateView(Blocks.CANDLE.defaultBlockState().setValue(BlockStateProperties.LIT,true));
        assertTrue(candle.getAsJsonPrimitive("lit").isBoolean());assertTrue(candle.get("lit").getAsBoolean());
        assertTrue(candle.getAsJsonPrimitive("candles").isNumber());assertEquals(1,candle.get("candles").getAsInt());
        assertFalse(candle.get("waterlogged").getAsBoolean());
        var door=SemanticPerception.stateView(Blocks.OAK_DOOR.defaultBlockState().setValue(BlockStateProperties.OPEN,true));
        assertTrue(door.get("open").getAsBoolean());assertTrue(door.getAsJsonPrimitive("facing").isString());
        var wheat=SemanticPerception.stateView(Blocks.WHEAT.defaultBlockState().setValue(BlockStateProperties.AGE_7,7));
        assertEquals(7,wheat.get("age").getAsInt());
        assertEquals("functional",SemanticPerception.category(Blocks.CAMPFIRE.defaultBlockState().setValue(BlockStateProperties.LIT,false),"minecraft:campfire",Set.of(),false));
        assertEquals("danger",SemanticPerception.category(Blocks.CAMPFIRE.defaultBlockState(),"minecraft:campfire",Set.of(),false));
    }
    @Test void aThinCandleOnAnOpaqueFloorIsVisibleAtItsActualShapeSurface() {
        var level=mock(ServerLevel.class);var agent=mock(AgentEntity.class);var candle=new BlockPos(2,0,0);
        when(agent.level()).thenReturn(level);when(agent.getEyePosition()).thenReturn(new Vec3(.5,1.6,.5));
        when(level.getBlockState(any())).thenReturn(Blocks.AIR.defaultBlockState());
        when(level.getBlockState(candle)).thenReturn(Blocks.CANDLE.defaultBlockState());
        when(level.getBlockState(candle.below())).thenReturn(Blocks.STONE.defaultBlockState());
        when(level.clip(any())).thenAnswer(call->{ClipContext ray=call.getArgument(0);
            return ray.getTo().y<.375?new BlockHitResult(ray.getTo(),Direction.UP,candle,false):BlockHitResult.miss(ray.getTo(),Direction.UP,candle);
        });
        try(var queries=mockStatic(WorldQueries.class)) {queries.when(()->WorldQueries.chunkLoaded(eq(level),any())).thenReturn(true);assertTrue(SemanticPerception.visible(agent,candle));}
    }
    @Test void groupingSeparatesDifferentStatesAndKeepsStateDiversityWithinTheBudget() {
        var unlit=SemanticPerception.stateView(Blocks.CANDLE.defaultBlockState());
        var lit=SemanticPerception.stateView(Blocks.CANDLE.defaultBlockState().setValue(BlockStateProperties.LIT,true));
        List<SemanticPerception.Sample> samples=new ArrayList<>();
        for(int n=0;n<5;n++)samples.add(new SemanticPerception.Sample("minecraft:candle","functional",new BlockPos(n,0,0),n,0,false,unlit));
        samples.add(new SemanticPerception.Sample("minecraft:candle","functional",new BlockPos(7,0,0),7,0,false,lit));
        var selected=SemanticPerception.select(SemanticPerception.group(samples,100));
        assertEquals(3,selected.size());
        assertTrue(selected.asList().stream().anyMatch(e->e.getAsJsonObject().getAsJsonObject("state").get("lit").getAsBoolean()));
        var first=new JsonObject();first.addProperty("lit",false);var second=new JsonObject();second.addProperty("lit",true);
        var ores=SemanticPerception.group(List.of(new SemanticPerception.Sample("minecraft:redstone_ore","ore",BlockPos.ZERO,0,0,false,first),new SemanticPerception.Sample("minecraft:redstone_ore","ore",new BlockPos(1,0,0),1,0,false,second)),1);
        assertEquals(2,ores.size());assertEquals(1,ores.get(0).get("count").getAsInt());
    }
    @Test void candlesSurviveTerrainTruncationAndFreshInspectionReflectsStateChanges() {
        ServerLevel level=mock(ServerLevel.class);AgentEntity agent=mock(AgentEntity.class);
        when(agent.level()).thenReturn(level);when(agent.position()).thenReturn(new Vec3(.5,0,.5));when(agent.getEyePosition()).thenReturn(new Vec3(.5,1.6,.5));
        when(level.getBlockState(any())).thenReturn(Blocks.AIR.defaultBlockState());
        List<BlockPos> source=new ArrayList<>();for(int x=0;x<12;x++)for(int z=0;z<12;z++){var p=new BlockPos(x,-1,z);source.add(p);when(level.getBlockState(p)).thenReturn(Blocks.DIRT.defaultBlockState());}
        var position=new BlockPos(2,0,2);source.add(position);when(level.getBlockState(position)).thenReturn(Blocks.CANDLE.defaultBlockState());
        when(level.clip(any())).thenAnswer(call->{ClipContext ray=call.getArgument(0);return new BlockHitResult(ray.getTo(),Direction.UP,BlockPos.containing(ray.getTo()),false);});
        try(var queries=mockStatic(WorldQueries.class)) {
            queries.when(()->WorldQueries.chunkLoaded(eq(level),any())).thenReturn(true);
            var scan=SemanticPerception.scan(agent,source,null);
            assertEquals(1,scan.getAsJsonArray("points_of_interest").size());
            assertFalse(scan.getAsJsonArray("points_of_interest").get(0).getAsJsonObject().getAsJsonObject("state").get("lit").getAsBoolean());
            var query=new JsonObject();query.addProperty("block_id","minecraft:candle");
            when(level.getBlockState(position)).thenReturn(Blocks.CANDLE.defaultBlockState().setValue(BlockStateProperties.LIT,true));
            var fresh=SemanticPerception.scan(agent,source,null);
            var detail=SemanticPerception.inspect(fresh,query).get(0).getAsJsonObject();
            assertTrue(detail.getAsJsonObject("state").get("lit").getAsBoolean());
            assertFalse(scan.getAsJsonArray("points_of_interest").get(0).getAsJsonObject().getAsJsonObject("state").get("lit").getAsBoolean());
        }
    }
    @Test void buriedBlocksNeverReachSummaryOrInspection() {
        ServerLevel level=mock(ServerLevel.class);AgentEntity agent=mock(AgentEntity.class);BlockPos ore=new BlockPos(3,0,0);
        when(agent.level()).thenReturn(level);when(agent.position()).thenReturn(Vec3.ZERO);when(agent.getEyePosition()).thenReturn(new Vec3(0.5,1.6,0.5));
        when(level.getBlockState(any())).thenReturn(Blocks.STONE.defaultBlockState());when(level.getBlockState(ore)).thenReturn(Blocks.ANCIENT_DEBRIS.defaultBlockState());
        try(var queries=mockStatic(WorldQueries.class)) {
            queries.when(()->WorldQueries.chunkLoaded(eq(level),any())).thenReturn(true);
            assertFalse(SemanticPerception.visible(agent,ore));
            var scan=SemanticPerception.scan(agent,List.of(ore),null);
            assertEquals(0,scan.getAsJsonArray("points_of_interest").size());
            assertEquals(0,SemanticPerception.inspect(scan,new com.google.gson.JsonObject()).size());
            verify(level,never()).clip(any());
        }
    }
    @Test void exposedButOccludedBlocksAreNotVisible() {
        ServerLevel level=mock(ServerLevel.class);AgentEntity agent=mock(AgentEntity.class);BlockPos ore=new BlockPos(3,0,0);
        when(agent.level()).thenReturn(level);when(agent.getEyePosition()).thenReturn(new Vec3(0.5,1.6,0.5));
        when(level.getBlockState(any())).thenReturn(Blocks.AIR.defaultBlockState());
        when(level.clip(any())).thenReturn(new BlockHitResult(new Vec3(1,1,0),Direction.WEST,new BlockPos(1,1,0),false));
        try(var queries=mockStatic(WorldQueries.class)) {
            queries.when(()->WorldQueries.chunkLoaded(eq(level),any())).thenReturn(true);
            assertFalse(SemanticPerception.visible(agent,ore));
            when(level.clip(any())).thenReturn(new BlockHitResult(new Vec3(3,0,0),Direction.WEST,ore,false));
            assertTrue(SemanticPerception.visible(agent,ore));
        }
    }
    @Test void classificationAndGroupedQuotasDoNotTreatEveryModBlockAsSpecial() {
        assertEquals("terrain",SemanticPerception.category(null,"mod:stone",Set.of("c:base_stone_overworld"),false));
        assertEquals("ore",SemanticPerception.category(null,"mod:tin",Set.of("c:ores/tin"),false));
        assertEquals("functional",SemanticPerception.category(null,"mod:machine",Set.of(),true));
        assertEquals("unknown",SemanticPerception.category(null,"mod:mystery",Set.of(),false));
        assertEquals(new SemanticPerception.Classification("functional",10),SemanticPerception.applyRules("mod:mystery",Set.of(),"unknown","mod:mystery|functional|10"));
        assertEquals(new SemanticPerception.Classification("ore",5),SemanticPerception.applyRules("mod:tin",Set.of("c:ores/tin"),"unknown","#c:ores/tin|ore|5"));
        List<SemanticPerception.Sample> samples=new ArrayList<>();
        for(int n=0;n<60;n++)samples.add(new SemanticPerception.Sample("mod:ore","ore",new BlockPos(n,0,0),n,0,false));
        for(int n=0;n<40;n++)samples.add(new SemanticPerception.Sample("mod:machine"+n,"functional",new BlockPos(n,1,0),n,0,false));
        for(int n=0;n<20;n++)samples.add(new SemanticPerception.Sample("mod:hazard"+n,"danger",new BlockPos(n,2,0),n,0,false));
        var groups=SemanticPerception.group(samples,1);var selected=SemanticPerception.select(groups);
        assertEquals(24,selected.size());
        assertTrue(selected.asList().stream().anyMatch(e->e.getAsJsonObject().get("count").getAsInt()==60));
        long danger=selected.asList().stream().filter(e->e.getAsJsonObject().get("category").getAsString().equals("danger")).count();assertTrue(danger>=4);
    }
}
