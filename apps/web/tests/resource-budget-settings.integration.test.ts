import { randomUUID } from "node:crypto";
import { beforeEach, afterEach, expect, it, vi } from "vitest";
import { prisma } from "@ai-cognitive/db";
import { GET, POST } from "../app/api/studio/resource-budget/route";
let actor:{workspaceId:string;userId:string};
vi.mock("@/lib/identity",()=>({resolveWebIdentity:async()=>actor}));
beforeEach(async()=>{actor={workspaceId:randomUUID(),userId:randomUUID()};await prisma.user.create({data:{id:actor.userId,email:`${actor.userId}@budget.test`}});await prisma.workspace.create({data:{id:actor.workspaceId,name:"额度设置回归"}});await prisma.workspaceMember.create({data:{...actor,role:"OWNER"}});});
afterEach(async()=>{await prisma.workspaceMember.deleteMany({where:actor});await prisma.workspace.delete({where:{id:actor.workspaceId}});await prisma.user.delete({where:{id:actor.userId}});});
const post=(body:unknown)=>POST(new Request("http://localhost/api/studio/resource-budget",{method:"POST",body:JSON.stringify(body)}));
it("默认启用上限，所有者可取消单任务限制且保留每日额度与原数值",async()=>{
  expect(await (await GET()).json()).toMatchObject({dailyUnitLimit:1000000,runUnitLimit:300000,runLimitEnabled:true});
  expect((await post({dailyUnitLimit:1000000,runUnitLimit:300000,runLimitEnabled:false})).status).toBe(200);
  expect(await (await GET()).json()).toMatchObject({dailyUnitLimit:1000000,runUnitLimit:300000,runLimitEnabled:false});
  expect((await post({dailyUnitLimit:1000000,runUnitLimit:300000})).status).toBe(200);
  expect(await (await GET()).json()).toMatchObject({runLimitEnabled:false});
});
it("非所有者不能取消上限，非法配置不会落库",async()=>{
  await prisma.workspaceMember.update({where:{workspaceId_userId:actor},data:{role:"EDITOR"}});
  expect((await post({dailyUnitLimit:1000000,runUnitLimit:300000,runLimitEnabled:false})).status).toBe(403);
  expect(await prisma.workspaceResourcePolicy.count({where:{workspaceId:actor.workspaceId}})).toBe(0);
});
it("开关必须是明确布尔值，非法输入不会改写额度",async()=>{
  expect((await post({dailyUnitLimit:1000000,runUnitLimit:300000,runLimitEnabled:"false"})).status).toBe(400);
  expect(await prisma.workspaceResourcePolicy.count({where:{workspaceId:actor.workspaceId}})).toBe(0);
});

it("并发默认为2，保存与旧客户端保存均保留设置，超限或非整数被拒绝", async () => {
  expect(await (await GET()).json()).toMatchObject({ bookChunkConcurrency: 2 });
  const base = { dailyUnitLimit: 1000000, runUnitLimit: 300000, runLimitEnabled: false };
  expect((await post({ ...base, bookChunkConcurrency: 4 })).status).toBe(200);
  expect((await post(base)).status).toBe(200);
  expect(await (await GET()).json()).toMatchObject({ bookChunkConcurrency: 4, runLimitEnabled: false });
  for (const value of [0, 5, 1.5, "2", null]) expect((await post({ ...base, bookChunkConcurrency: value })).status).toBe(400);
  expect(await (await GET()).json()).toMatchObject({ bookChunkConcurrency: 4 });
});
it("其他成员不能修改分块并发数", async () => {
  await prisma.workspaceMember.update({where:{workspaceId_userId:actor},data:{role:"EDITOR"}});
  expect((await post({dailyUnitLimit:1000000,runUnitLimit:300000,bookChunkConcurrency:3})).status).toBe(403);
});
