package com.trix.gamebot.bridge.observation;

import com.google.gson.*;
import com.trix.gamebot.bridge.config.CommonBridgeConfig;
import com.trix.gamebot.bridge.entity.AgentEntity;
import net.minecraft.core.BlockPos;
import net.minecraft.core.Direction;
import net.minecraft.core.registries.BuiltInRegistries;
import net.minecraft.world.level.ClipContext;
import net.minecraft.world.level.block.state.BlockState;
import net.minecraft.world.level.block.state.properties.Property;
import net.minecraft.world.phys.Vec3;
import java.util.*;

/** Only eye-visible facts leave this boundary. Buried blocks never enter summaries or inspect results. */
public final class SemanticPerception {
    public record Sample(String id, String category, BlockPos pos, double distance, int priority, boolean matches, JsonObject state) {
        public Sample { state = state == null ? new JsonObject() : state.deepCopy(); }
        public Sample(String id, String category, BlockPos pos, double distance, int priority, boolean matches) { this(id,category,pos,distance,priority,matches,new JsonObject()); }
    }
    public record Classification(String category,int priority) {}
    private static final List<String> CATEGORIES=List.of("danger","functional","ore","unknown");
    public static boolean visible(AgentEntity agent, BlockPos pos) {
        var level=agent.level();
        if(!WorldQueries.chunkLoaded(level,pos)) return false;
        Vec3 eye=agent.getEyePosition();
        var shape=level.getBlockState(pos).getShape(level,pos,net.minecraft.world.phys.shapes.CollisionContext.of(agent));
        List<net.minecraft.world.phys.AABB> boxes=shape.isEmpty()?List.of(new net.minecraft.world.phys.AABB(0,0,0,1,1,1)):shape.toAabbs().stream().limit(16).toList();
        for(Direction face:Direction.values()) {
            BlockPos adjacent=pos.relative(face);
            if(!WorldQueries.chunkLoaded(level,adjacent) || level.getBlockState(adjacent).canOcclude()) continue;
            for(var box:boxes) {
            Vec3 end=box.getCenter().add(pos.getX(),pos.getY(),pos.getZ()).add(
                face.getStepX()*Math.max(0,box.getXsize()/2-.001),face.getStepY()*Math.max(0,box.getYsize()/2-.001),face.getStepZ()*Math.max(0,box.getZsize()/2-.001));
            int steps=(int)Math.ceil(eye.distanceTo(end)); boolean loaded=true;
            for(int n=0;n<=steps;n++) if(!WorldQueries.chunkLoaded(level,BlockPos.containing(eye.lerp(end,n/(double)Math.max(1,steps))))) {loaded=false;break;}
            if(!loaded) continue;
            var hit=level.clip(new ClipContext(eye,end,ClipContext.Block.OUTLINE,ClipContext.Fluid.ANY,agent));
            if(hit.getType()==net.minecraft.world.phys.HitResult.Type.BLOCK && hit.getBlockPos().equals(pos)) return true;
            }
        }
        return false;
    }
    public static String category(BlockState state,String id,Set<String> tags,boolean functional) {
        if(id.contains("lava") || id.endsWith(":fire") || id.contains("campfire") && (state == null || !state.hasProperty(net.minecraft.world.level.block.state.properties.BlockStateProperties.LIT) || state.getValue(net.minecraft.world.level.block.state.properties.BlockStateProperties.LIT)) || id.endsWith(":cactus") || id.endsWith(":magma_block")) return "danger";
        if(functional || Set.of("minecraft:crafting_table","minecraft:anvil","minecraft:chipped_anvil","minecraft:damaged_anvil","minecraft:stonecutter","minecraft:grindstone","minecraft:smithing_table","minecraft:lever").contains(id)) return "functional";
        if(tags.stream().anyMatch(t->t.endsWith(":ores") || t.contains(":ores/") || t.endsWith("_ores")) || id.equals("minecraft:ancient_debris")) return "ore";
        if(state != null && (state.getBlock() instanceof net.minecraft.world.level.block.AbstractCauldronBlock || state.getBlock() instanceof net.minecraft.world.level.block.ComposterBlock)) return "functional";
        if(state != null && state.getProperties().stream().anyMatch(p -> Set.of("lit","open","powered","power","age","stage","moisture","honey_level","charges","has_record","has_book","bites","hatch","berries","occupied","triggered","crafting","enabled","inverted","delay","mode").contains(p.getName()))) return "functional";
        if(tags.stream().anyMatch(t->t.contains("base_stone") || t.endsWith(":dirt") || t.endsWith(":logs") || t.endsWith(":leaves") || t.endsWith(":sand"))) return "terrain";
        return id.startsWith("minecraft:")?"terrain":"unknown";
    }
    public static JsonObject scan(AgentEntity agent,List<BlockPos> source,String interest) {
        List<Sample> samples=new ArrayList<>(),details=new ArrayList<>(); Map<String,Integer> materials=new TreeMap<>(),unknownSeen=new HashMap<>();
        int terrainChecks=0;
        String rules=""; try{rules=CommonBridgeConfig.PERCEPTION_RULES.get();}catch(IllegalStateException ignored){}
        String[] configuredRules=rules.split(";");
        for(BlockPos pos:source) {
            var state=agent.level().getBlockState(pos); String id=BuiltInRegistries.BLOCK.getKey(state.getBlock()).toString();
            Set<String> tags=new HashSet<>(); state.getTags().forEach(t->tags.add(t.location().toString()));
            String category=category(state,id,tags,state.hasBlockEntity() || state.getMenuProvider(agent.level(),pos)!=null);
            Classification classified=applyRules(id,tags,category,configuredRules);
            category=classified.category;int priority=classified.priority;
            if(category.equals("ignore")) continue;
            if(category.equals("terrain") && terrainChecks++>=128) continue;
            JsonObject properties = stateView(state);
            String unknownKey = id + ":" + properties;
            if(category.equals("unknown") && unknownSeen.getOrDefault(unknownKey,0)>=3) continue;
            if(!visible(agent,pos)) continue;
            details.add(new Sample(id,category,pos,agent.position().distanceTo(Vec3.atCenterOf(pos)),priority,false,properties));
            if(category.equals("terrain")) {materials.merge(id,1,Integer::sum);continue;}
            if(category.equals("unknown")) unknownSeen.merge(unknownKey,1,Integer::sum);
            boolean match=interest!=null && (interest.equals(id) || interest.equals(category) || interest.startsWith("#") && tags.contains(interest.substring(1)));
            samples.add(new Sample(id,category,pos,agent.position().distanceTo(Vec3.atCenterOf(pos)),priority,match,properties));
        }
        List<JsonObject> groups=group(samples,agent.level().getGameTime());
        JsonObject out=new JsonObject(),terrain=new JsonObject(); JsonArray materialView=new JsonArray();
        materials.entrySet().stream().sorted(Map.Entry.<String,Integer>comparingByValue().reversed()).limit(8).forEach(e->{JsonObject m=new JsonObject();m.addProperty("block_id",e.getKey());m.addProperty("visible_samples",e.getValue());materialView.add(m);});
        terrain.add("surface_materials",materialView); terrain.addProperty("visibility","eye_ray_visible_only"); terrain.addProperty("sampled",true);
        terrain.addProperty("visible_water_samples",materials.getOrDefault("minecraft:water",0));
        terrain.addProperty("visible_hazard_groups",groups.stream().filter(g->g.get("category").getAsString().equals("danger")).count());
        out.add("terrain_summary",terrain); out.add("points_of_interest",select(groups));
        JsonArray detailView=new JsonArray(); group(details,agent.level().getGameTime()).forEach(detailView::add); out.add("visible_details",detailView);
        return out;
    }
    public static JsonObject stateView(BlockState state) {
        JsonObject view = new JsonObject();
        state.getProperties().stream().sorted(Comparator.comparing(Property::getName)).forEach(p -> addProperty(view,state,p));
        return view;
    }
    private static <T extends Comparable<T>> void addProperty(JsonObject view, BlockState state, Property<T> property) {
        T value=state.getValue(property);
        if(value instanceof Boolean bool) view.addProperty(property.getName(),bool);
        else if(value instanceof Number number) view.addProperty(property.getName(),number);
        else view.addProperty(property.getName(),property.getName(value));
    }
    public static Classification applyRules(String id,Set<String> tags,String category,String... rules) {
        int priority=0;
        for(String rule:rules) {
            String[] fields=rule.trim().split("\\|");if(fields.length<2)continue;
            if(fields[0].equals(id)||(fields[0].startsWith("#")&&tags.contains(fields[0].substring(1)))) {
                if(CATEGORIES.contains(fields[1])||fields[1].equals("terrain")||fields[1].equals("ignore"))category=fields[1];
                try{priority=fields.length>2?Math.max(-100,Math.min(100,Integer.parseInt(fields[2]))):0;}catch(NumberFormatException ignored){}
            }
        }return new Classification(category,priority);
    }
    public static void addDirections(JsonObject scan,JsonArray feet,Vec3 origin) {
        JsonObject summary=scan.getAsJsonObject("terrain_summary"),directions=new JsonObject();
        for(String direction:List.of("north","south","east","west")) {
            double low=Double.POSITIVE_INFINITY,high=Double.NEGATIVE_INFINITY;int count=0;
            for(var element:feet) {var p=element.getAsJsonObject().getAsJsonObject("position");double x=p.get("x").getAsDouble()-origin.x,z=p.get("z").getAsDouble()-origin.z,y=p.get("y").getAsDouble();
                String label=Math.abs(x)>Math.abs(z)?(x>0?"east":"west"):(z>0?"south":"north");
                if(label.equals(direction)){count++;low=Math.min(low,y);high=Math.max(high,y);}
            }
            JsonObject d=new JsonObject();d.addProperty("standing_samples",count);d.addProperty("route_verified",false);
            if(count>0){d.addProperty("min_feet_y",low);d.addProperty("max_feet_y",high);}else d.addProperty("status","unknown");directions.add(direction,d);
        }summary.add("directions",directions);
    }
    public static List<JsonObject> group(List<Sample> source,long gameTime) {
        Map<BlockPos,Sample> remaining=new HashMap<>(); for(Sample s:source) remaining.put(s.pos,s);
        List<JsonObject> out=new ArrayList<>();
        while(!remaining.isEmpty()) {
            Sample start=remaining.values().iterator().next(); remaining.remove(start.pos);
            List<Sample> connected=new ArrayList<>(); connected.add(start);
            if(start.category.equals("ore")) for(int n=0;n<connected.size();n++) for(Direction d:Direction.values()) {
                Sample next=remaining.get(connected.get(n).pos.relative(d));
                if(next!=null && next.id.equals(start.id) && next.category.equals(start.category) && next.state.equals(start.state)) {remaining.remove(next.pos);connected.add(next);}
            }
            Sample representative=connected.stream().min(Comparator.comparingDouble(Sample::distance)).orElse(start);
            JsonObject view=new JsonObject(),p=new JsonObject();p.addProperty("x",representative.pos.getX());p.addProperty("y",representative.pos.getY());p.addProperty("z",representative.pos.getZ());
            view.addProperty("block_id",start.id); view.addProperty("category",start.category);view.add("pos",p);
            view.add("state", representative.state.deepCopy());
            view.addProperty("count",connected.size());view.addProperty("distance",representative.distance);view.addProperty("observed_at",gameTime);
            view.addProperty("priority",start.priority);view.addProperty("task_match",start.matches);view.addProperty("visibility","current");out.add(view);
        }
        out.sort(order());return out;
    }
    private static Comparator<JsonObject> order(){return Comparator.<JsonObject>comparingInt(x->x.get("task_match").getAsBoolean()?0:1)
            .thenComparingInt(x->-x.get("priority").getAsInt()).thenComparingInt(x->CATEGORIES.indexOf(x.get("category").getAsString()))
            .thenComparingDouble(x->x.get("distance").getAsDouble()).thenComparing(x->x.get("block_id").getAsString())
            .thenComparing(x->x.get("pos").toString());}
    public static JsonArray select(List<JsonObject> groups) {
        List<JsonObject> sorted=new ArrayList<>(groups);sorted.sort(order());
        List<JsonObject> distinct=new ArrayList<>(),duplicates=new ArrayList<>();Set<String> states=new HashSet<>();
        for(JsonObject row:sorted) {String key=row.get("block_id").getAsString()+":"+row.get("state");if(states.add(key))distinct.add(row);else duplicates.add(row);}
        sorted.clear();sorted.addAll(distinct);sorted.addAll(duplicates);
        List<JsonObject> selected=new ArrayList<>();Map<String,Integer> perId=new HashMap<>();
        int[] quotas={4,6,6,4};
        for(int n=0;n<CATEGORIES.size();n++) {int added=0;for(JsonObject row:sorted) if(row.get("category").getAsString().equals(CATEGORIES.get(n)) && added<quotas[n] && take(row,selected,perId)) added++;}
        for(JsonObject row:sorted) if(selected.size()<24) take(row,selected,perId);
        selected.sort(order());JsonArray out=new JsonArray();selected.forEach(out::add);return out;
    }
    private static boolean take(JsonObject row,List<JsonObject> selected,Map<String,Integer> counts) {
        String id=row.get("block_id").getAsString();if(selected.contains(row)||counts.getOrDefault(id,0)>=3)return false;
        selected.add(row);counts.merge(id,1,Integer::sum);return true;
    }
    public static JsonArray inspect(JsonObject scan,JsonObject params) {
        JsonArray result=new JsonArray(); for(var element:scan.getAsJsonArray("visible_details")) {
            JsonObject row=element.getAsJsonObject();
            if(params.has("block_id")&&!params.get("block_id").equals(row.get("block_id"))) continue;
            if(params.has("category")&&!params.get("category").equals(row.get("category"))) continue;
            if(params.has("tag")) {
                var block=BuiltInRegistries.BLOCK.get(net.minecraft.resources.ResourceLocation.parse(row.get("block_id").getAsString()));
                if(block.defaultBlockState().getTags().noneMatch(t->t.location().toString().equals(params.get("tag").getAsString()))) continue;
            }
            result.add(row);if(result.size()>=32)break;
        }return result;
    }
}
