import {expect,it} from "vitest";
import {worldConfig, mapTargets, portalRoute, reachableApproach} from "../src/game/config/worldConfig";
import workshop from "../public/assets/maps/workshop.json";
it("connects each teaching room through the town and keeps the professor reachable from the door",()=>{
  const rooms=["library","workshop","arena","mayor_hall"];
  for(const name of rooms){
    expect(portalRoute("town_hub",name,[])?.at(-1)?.to.map_key).toBe(name);
    expect(mapTargets(name).some(t=>t.portal?.to.map_key==="town_hub")).toBe(true);
  }
  const door=worldConfig.portals.find(p=>p.to.map_key==="workshop")!;
  const collision=workshop.layers.find(l=>l.name==="collision")!.data!;
  const route=reachableApproach({x:door.to.tile_x,y:door.to.tile_y},{x:9,y:5},1,workshop.width,workshop.height,(x,y)=>Boolean(collision[y*workshop.width+x]));
  expect(route?.path.length).toBeGreaterThan(0);
});
