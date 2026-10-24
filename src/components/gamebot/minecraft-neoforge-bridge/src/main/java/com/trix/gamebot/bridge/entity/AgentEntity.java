package com.trix.gamebot.bridge.entity;

import net.minecraft.core.registries.BuiltInRegistries;
import net.minecraft.nbt.CompoundTag;
import net.minecraft.nbt.ListTag;
import net.minecraft.nbt.Tag;
import net.minecraft.network.chat.Component;
import net.minecraft.server.level.ServerLevel;
import net.minecraft.world.InteractionHand;
import net.minecraft.world.SimpleContainer;
import net.minecraft.world.entity.EntityType;
import net.minecraft.world.entity.EquipmentSlot;
import net.minecraft.world.entity.PathfinderMob;
import net.minecraft.world.entity.ai.attributes.AttributeSupplier;
import net.minecraft.world.entity.ai.attributes.Attributes;
import net.minecraft.world.entity.ai.navigation.PathNavigation;
import net.minecraft.world.item.ItemStack;
import net.minecraft.world.level.Level;

/** 服务端自定义 NPC。不占用玩家角色，也不读取屏幕或系统焦点。 */
public class AgentEntity extends PathfinderMob {
    public static final int SLOT_COUNT = 36;
    private final SimpleContainer inventory = new SimpleContainer(SLOT_COUNT);
    private ItemStack offhand = ItemStack.EMPTY;
    private int selectedSlot;
    private String agentName = "";
    private String memberId = "";
    private String goal = "";
    private boolean handLocked;
    private double lookX;
    private double lookY;
    private double lookZ;
    private boolean lookAtActive;

    public AgentEntity(EntityType<? extends AgentEntity> type, Level level) {
        super(type, level);
        setPersistenceRequired();
        if (getAttribute(Attributes.MOVEMENT_SPEED) != null) {
            getAttribute(Attributes.MOVEMENT_SPEED).setBaseValue(0.25);
        }
        if (getAttribute(Attributes.STEP_HEIGHT) != null) {
            getAttribute(Attributes.STEP_HEIGHT).setBaseValue(1.0);
        }
        if (getAttribute(Attributes.FOLLOW_RANGE) != null) {
            getAttribute(Attributes.FOLLOW_RANGE).setBaseValue(48.0);
        }
        getNavigation().setCanFloat(true);
    }

    public static AttributeSupplier.Builder createAttributes() {
        return PathfinderMob.createMobAttributes().add(Attributes.ATTACK_DAMAGE, 2.0);
    }

    public SimpleContainer inventory() {
        return inventory;
    }

    public int selectedSlot() {
        return selectedSlot;
    }

    public String agentName() {
        return agentName;
    }

    public String memberId() {
        return memberId;
    }

    public void setMemberId(String id) {
        memberId = id == null ? "" : id;
    }

    public String goal() {
        return goal;
    }

    public void setAgentName(String name) {
        agentName = name == null ? "" : name;
        setCustomName(Component.literal(agentName.isEmpty() ? "Minaret" : agentName));
        setCustomNameVisible(true);
    }

    public void setGoal(String next) {
        if (next == null) {
            return;
        }
        String trimmed = next.trim();
        if (trimmed.length() > 200) {
            trimmed = trimmed.substring(0, 200);
        }
        goal = trimmed;
    }

    public ItemStack selectedStack() {
        return inventory.getItem(selectedSlot);
    }

    public void selectSlot(int slot) {
        selectedSlot = Math.max(0, Math.min(8, slot));
        if (!handLocked) {
            refreshHands();
        }
    }

    public int findHotbar(String itemId) {
        for (int slot = 0; slot <= 8; slot++) {
            ItemStack stack = inventory.getItem(slot);
            if (!stack.isEmpty() && itemId.equals(itemId(stack))) {
                return slot;
            }
        }
        return -1;
    }

    public boolean itemOutsideHotbar(String itemId) {
        for (int slot = 9; slot < inventory.getContainerSize(); slot++) {
            ItemStack stack = inventory.getItem(slot);
            if (!stack.isEmpty() && itemId.equals(itemId(stack))) {
                return true;
            }
        }
        return false;
    }

    public void armMainHand() {
        setItemSlot(EquipmentSlot.MAINHAND, selectedStack().copy());
        setItemSlot(EquipmentSlot.OFFHAND, offhand.copy());
        handLocked = true;
    }

    public void disarmMainHand() {
        if (handLocked) {
            inventory.setItem(selectedSlot, getMainHandItem().copy());
            offhand = getOffhandItem().copy();
        }
        handLocked = false;
        refreshHands();
    }

    public void lookAtPoint(double x, double y, double z) {
        lookX = x;
        lookY = y;
        lookZ = z;
        lookAtActive = true;
    }

    /** Stop tick() from applying lookAt over a facing chosen for placement. Returns the previous flag. */
    public boolean suspendLook() {
        boolean active = lookAtActive;
        lookAtActive = false;
        return active;
    }

    public void resumeLook() {
        lookAtActive = true;
    }

    /** Face a horizontal direction without arming lookAt. tick() will not overwrite this until resumeLook. */
    public void lockFacing(float yaw, float pitch) {
        lookAtActive = false;
        setYRot(yaw);
        setXRot(pitch);
        setYHeadRot(yaw);
        setYBodyRot(yaw);
    }

    public void refreshHands() {
        setItemSlot(EquipmentSlot.MAINHAND, selectedStack().copy());
        setItemSlot(EquipmentSlot.OFFHAND, offhand.copy());
    }

    public static String itemId(ItemStack stack) {
        if (stack == null || stack.isEmpty()) {
            return null;
        }
        return BuiltInRegistries.ITEM.getKey(stack.getItem()).toString();
    }

    @Override
    protected PathNavigation createNavigation(Level level) {
        return new net.minecraft.world.entity.ai.navigation.GroundPathNavigation(this, level);
    }

    @Override
    protected void registerGoals() {
    }

    @Override
    public boolean removeWhenFarAway(double distance) {
        return false;
    }

    @Override
    public void tick() {
        if (!level().isClientSide && lookAtActive) {
            getLookControl().setLookAt(lookX, lookY, lookZ, 10.0F, 10.0F);
        }
        super.tick();
        if (level().isClientSide || !(level() instanceof ServerLevel serverLevel)) {
            return;
        }
        AgentRegistry registry = AgentRegistry.get(serverLevel.getServer());
        if (!registry.ownsEntity(getUUID())) {
            discard();
            return;
        }
        AgentRecord record = registry.findByEntity(getUUID());
        if (record != null && !record.agentKey().isEmpty() && !record.agentKey().equals(memberId)) {
            setMemberId(record.agentKey());
        }
        if (!handLocked) {
            refreshHands();
        }
        if (tickCount % 40 == 0) {
            registry.remember(this);
        }
    }

    @Override
    public void addAdditionalSaveData(CompoundTag tag) {
        super.addAdditionalSaveData(tag);
        tag.putString("AgentName", agentName);
        tag.putString("AgentMemberId", memberId);
        tag.putString("Goal", goal);
        tag.putInt("SelectedSlot", selectedSlot);
        tag.put("Offhand", offhand.save(registryAccess()));
        ListTag items = new ListTag();
        for (int slot = 0; slot < inventory.getContainerSize(); slot++) {
            ItemStack stack = inventory.getItem(slot);
            if (stack.isEmpty()) {
                continue;
            }
            CompoundTag entry = new CompoundTag();
            entry.putByte("Slot", (byte) slot);
            Tag saved = stack.save(registryAccess());
            if (saved instanceof CompoundTag compound) {
                entry.put("Item", compound);
            }
            items.add(entry);
        }
        tag.put("Inventory", items);
    }

    @Override
    public void readAdditionalSaveData(CompoundTag tag) {
        super.readAdditionalSaveData(tag);
        setAgentName(tag.getString("AgentName"));
        memberId = tag.contains("AgentMemberId") ? tag.getString("AgentMemberId") : "";
        goal = tag.getString("Goal");
        selectedSlot = Math.max(0, Math.min(8, tag.getInt("SelectedSlot")));
        offhand = ItemStack.parseOptional(registryAccess(), tag.getCompound("Offhand"));
        inventory.clearContent();
        ListTag items = tag.getList("Inventory", Tag.TAG_COMPOUND);
        for (Tag raw : items) {
            if (!(raw instanceof CompoundTag entry)) {
                continue;
            }
            int slot = entry.getByte("Slot") & 255;
            if (slot < 0 || slot >= inventory.getContainerSize()) {
                continue;
            }
            inventory.setItem(slot, ItemStack.parseOptional(registryAccess(), entry.getCompound("Item")));
        }
        refreshHands();
    }

    public ItemStack handStack(String hand) {
        if ("off_hand".equals(hand)) {
            return offhand;
        }
        return selectedStack();
    }

    public InteractionHand interactionHand(String hand) {
        return "off_hand".equals(hand) ? InteractionHand.OFF_HAND : InteractionHand.MAIN_HAND;
    }
}
