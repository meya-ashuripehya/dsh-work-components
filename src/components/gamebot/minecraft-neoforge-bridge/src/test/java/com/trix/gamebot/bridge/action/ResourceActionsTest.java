package com.trix.gamebot.bridge.action;

import com.trix.gamebot.bridge.entity.AgentEntity;
import net.minecraft.SharedConstants;
import net.minecraft.server.Bootstrap;
import net.minecraft.world.SimpleContainer;
import net.minecraft.world.entity.item.ItemEntity;
import net.minecraft.world.entity.player.Abilities;
import net.minecraft.world.entity.player.Inventory;
import net.minecraft.world.item.Items;
import net.minecraft.world.item.ItemStack;
import net.minecraft.world.level.block.state.BlockState;
import net.neoforged.neoforge.common.util.FakePlayer;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Test;
import static org.mockito.Mockito.*;
import static org.junit.jupiter.api.Assertions.*;

class ResourceActionsTest {
    @BeforeAll static void boot() { SharedConstants.tryDetectVersion(); Bootstrap.bootStrap(); }
    @Test void dropSearchSkipsAnInsufficientHotbarStackAndFindsAFullInventoryStack() {
        var inv=new SimpleContainer(36);inv.setItem(0,new ItemStack(Items.DIRT,2));inv.setItem(28,new ItemStack(Items.DIRT,5));
        assertEquals(28,ResourceActions.dropSlot(inv,"minecraft:dirt",3));
        assertEquals(-1,ResourceActions.dropSlot(inv,"minecraft:dirt",9));
        assertEquals(-1,ResourceActions.dropSlot(inv,"minecraft:diamond",1));
        assertEquals(0,ResourceActions.dropSlot(inv,"minecraft:dirt",1));
    }
    @Test void requiredHarvestTierRejectsWrongToolsAndFindsToolBeyondHotbar() {
        var inv = new SimpleContainer(36); var state = mock(BlockState.class);
        when(state.requiresCorrectToolForDrops()).thenReturn(true);
        var wrong = mock(ItemStack.class); when(wrong.getDestroySpeed(state)).thenReturn(100f);
        inv.setItem(0, wrong);
        assertEquals(-1, ResourceActions.bestTool(inv, state));
        var correct = mock(ItemStack.class); when(correct.isCorrectToolForDrops(state)).thenReturn(true); when(correct.getDestroySpeed(state)).thenReturn(4f);
        inv.setItem(27, correct);
        assertEquals(27, ResourceActions.bestTool(inv, state));
    }
    @Test void handHarvestAndFasterOptionalToolAreBothSupported() {
        var inv = new SimpleContainer(36); var state = mock(BlockState.class);
        assertTrue(ResourceActions.bestTool(inv, state) >= 0);
        var axe = mock(ItemStack.class); when(axe.getDestroySpeed(state)).thenReturn(8f);
        inv.setItem(19, axe); assertEquals(19, ResourceActions.bestTool(inv, state));
    }
    @Test void fullAndPartialPickupsDoNotDeleteOverflowOrInventInventoryItems() {
        for (int free : new int[]{0, 4, 64}) {
            var agent = mock(AgentEntity.class); var inv = new SimpleContainer(36);
            for(int i=0;i<36;i++)inv.setItem(i,new ItemStack(Items.DIRT,64));
            if(free==64)inv.setItem(35,ItemStack.EMPTY);else inv.getItem(35).setCount(64-free);
            when(agent.inventory()).thenReturn(inv); when(agent.handStack("off_hand")).thenReturn(ItemStack.EMPTY);
            var fake = mock(FakePlayer.class); when(fake.getAbilities()).thenReturn(new Abilities());
            var inventory = new Inventory(fake); for(int i=0;i<36;i++)inventory.setItem(i,inv.getItem(i).copy());
            when(fake.getInventory()).thenReturn(inventory); when(fake.getOffhandItem()).thenReturn(ItemStack.EMPTY);
            var entity = mock(ItemEntity.class); var drop = new ItemStack(Items.DIRT,10); when(entity.getItem()).thenReturn(drop);
            doAnswer(call -> { inventory.add(drop); return null; }).when(entity).playerTouch(fake);
            int before=ResourceActions.count(inv,new ItemStack(Items.DIRT));
            ResourceActions.takeOne(agent,entity,fake);
            int picked=Math.min(free,10);
            assertEquals(before+picked,ResourceActions.count(inv,new ItemStack(Items.DIRT)));
            assertEquals(10-picked,drop.getCount());
            if(picked>0)verify(agent).recordPickup("minecraft:dirt",picked);else verify(agent,never()).recordPickup(anyString(),anyInt());
        }
    }
    @Test void pluginDeletingAnItemWithoutAddingItIsNotReportedAsAcquisition() {
        var agent=mock(AgentEntity.class);var inv=new SimpleContainer(36);
        when(agent.inventory()).thenReturn(inv);when(agent.handStack("off_hand")).thenReturn(ItemStack.EMPTY);
        var fake=mock(FakePlayer.class);when(fake.getInventory()).thenReturn(new Inventory(fake));when(fake.getOffhandItem()).thenReturn(ItemStack.EMPTY);
        var item=mock(ItemEntity.class);when(item.getItem()).thenReturn(new ItemStack(Items.DIRT,2));
        doAnswer(call->{item.getItem().setCount(0);return null;}).when(item).playerTouch(fake);
        ResourceActions.takeOne(agent,item,fake);
        verify(agent,never()).recordPickup(anyString(),anyInt());
    }
}
