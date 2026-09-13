const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const express = require('express');
const {createMetaWebhookSignature, captureMetaRawBody} = require('../app/webhooks/metaWebhookSignature');
const {createInstagramAdapter} = require('../adapters/instagramAdapter');
const {createFacebookAdapter} = require('../adapters/facebookAdapter');
const {createCommunityRuntime} = require('../app/community/createCommunityRuntime');
const {loadSocialAccounts} = require('../app/accounts/accountConfig');

const fixtures = [
  {platform:'instagram', object:'instagram', make:createInstagramAdapter, field:'comments', value:{id:'c1',text:'Hello',from:{id:'visitor'},media:{id:'post'}}},
  {platform:'facebook', object:'page', make:createFacebookAdapter, field:'feed', value:{comment_id:'c1',item:'comment',verb:'add',message:'Hello',from:{id:'visitor'},post_id:'post'}}
];
for(const fixture of fixtures) {
  test(`${fixture.platform} ingress rejects absent/wrong identity and malformed arrays`,()=>{
    const adapter=fixture.make({userId:'owner'});
    const entry={id:'owner',changes:[{field:fixture.field,value:fixture.value}]};
    assert.equal(adapter.parseWebhook({object:fixture.object,entry:[entry]}).length,1);
    for(const id of [undefined,'other']) assert.deepEqual(adapter.parseWebhook({object:fixture.object,entry:[{...entry,id}]}),[]);
    assert.deepEqual(fixture.make({}).parseWebhook({object:fixture.object,entry:[entry]}),[]);
    assert.deepEqual(adapter.parseWebhook({object:fixture.object,entry:{}}),[]);
    assert.deepEqual(adapter.parseWebhook({object:fixture.object,entry:[{id:'owner',changes:{}}]}),[]);
  });
}
test('Instagram accepts Facebook Login comment_id and media_id shape',()=>{
  const [event]=createInstagramAdapter({userId:'owner'}).parseWebhook({object:'instagram',entry:[{id:'owner',changes:[{field:'comments',value:{comment_id:'c',media_id:'m',text:'Hello',from:{id:'u'}}}]}]});
  assert.equal(event.sourceId,'c');assert.equal(event.rootId,'m');
});
test('HTTP webhook verifies exact raw bytes, rejects tampering and wrong app secret',async t=>{
  let handled=0;
  const app=express();
  app.use(express.json({verify:captureMetaRawBody}));
  app.post('/webhook',createMetaWebhookSignature({env:{INSTAGRAM_APP_SECRET:'ig-fixture',FACEBOOK_APP_SECRET:'fb-fixture'}}),(_req,res)=>{handled++;res.sendStatus(200);});
  const server=app.listen(0,'127.0.0.1');
  t.after(()=>new Promise(resolve=>server.close(resolve)));
  await new Promise(resolve=>server.once('listening',resolve));
  const url=`http://127.0.0.1:${server.address().port}/webhook`;
  const body='{ "object": "instagram", "entry": [] }';
  const sign=(secret,data)=>'sha256='+crypto.createHmac('sha256',secret).update(data).digest('hex');
  for(const [payload,signature,status] of [[body,sign('ig-fixture',body),200],[body,undefined,403],[body,sign('fb-fixture',body),403],[body+' ',sign('ig-fixture',body),403],[body,'sha256=bad',403]]) {
    const headers={'Content-Type':'application/json'};if(signature) headers['x-hub-signature-256']=signature;
    assert.equal((await fetch(url,{method:'POST',headers,body:payload})).status,status);
  }
  assert.equal(handled,1);
});
test('missing signing secret fails closed; strict Threads mode also fails closed',()=>{
  for(const [body,env] of [[{object:'instagram'},{}],[{object:'page'},{}],[{values:[]},{META_WEBHOOK_SIGNATURE_REQUIRED:'true'}]]) {
    let status;createMetaWebhookSignature({env})({body,get:()=>''},{sendStatus:s=>status=s},()=>assert.fail('must not dispatch'));
    assert.equal(status,503);
  }
});
test('isolated account profile refuses a foreign brand and does not inherit Threads verification token',()=>{
  const env={SOCIAL_BRAND:'astel.us',SOCIAL_REQUIRE_BRAND_ISOLATION:'true',THREADS_USERNAME:'astel.us',THREADS_VERIFY_TOKEN:'fixture',INSTAGRAM_USERNAME:'astel.us'};
  assert.equal(loadSocialAccounts(env)[1].verifyToken,null);
  assert.throws(()=>loadSocialAccounts({...env,INSTAGRAM_BRAND:'leoakastel'}),/ISOLATION/);
});

function runtimeFixture({dryRun=false,commitThrows=false,canPublish=async()=>true,publishResult={status:'published',id:'r1'}}={}) {
  const counts={published:0,rollback:0,held:0,memory:[]};let done=false;
  const account={key:'astel.us:instagram',platform:'instagram',username:'astel.us',userId:'owner',enabled:true,dryRun};
  const provider={account,platform:'instagram',accountKey:account.key,health:()=>({configured:true}),getCommentId:e=>e.sourceId,getAuthorUsername:e=>e.author.username,getAuthorId:e=>e.author.id,getRootPostId:e=>e.rootId,getCommentText:e=>e.text,getParentId:e=>e.rootId,resolveParentAuthor:async e=>({parentId:e.rootId,parentAuthorId:'owner',parentAuthorUsername:'astel.us'}),reply:async()=>{counts.published++;return publishResult;}};
  const runtime=createCommunityRuntime({provider,policy:{normalReplyLimit:3,cooldownSeconds:20,conversationResetHours:24,globalDailyLimit:50,redisRequired:true},getContext:async()=>'',generateReply:async()=>({text:'A controlled reply'}),canPublish});
  Object.assign(runtime.safety,{isEnabled:()=>true,isDryRun:()=>dryRun,isReady:()=>true,isSelfAuthored:({authorId})=>authorId==='owner',isBotGeneratedId:async()=>false,getSourceStatus:async()=>done?'DONE':null,recordGraphNode:async()=>({}),getGraphNode:async()=>({relationshipStatus:'RESOLVED',branchKey:'branch'}),getUserKey:()=> 'visitor',getConversationKey:()=> 'conversation',reserve:async()=>({allowed:true,reservationId:'lease',replyNumber:1}),acquireBranchLease:async()=>true,verifyBranchLease:async()=>true,releaseBranchLease:async()=>{},getBranchMemory:async()=>({reason:'OK',messages:[]}),commitSuccess:async(_reservation,id,text)=>{if(commitThrows)throw Error('store lost');done=true;if(id)counts.memory.push({id,text});return true;},rollback:async()=>counts.rollback++,markAmbiguous:async()=>{counts.held++;done=true;}});
  Object.assign(runtime.humanLocks,{isReady:()=>true,isLocked:async()=>false});
  const event={sourceId:'c1',rootId:'post',text:'Hello',author:{id:'visitor',username:'visitor'}};
  return {runtime,event,counts};
}
test('secondary dry-run does not publish or add synthetic reply memory; replay is deduplicated',async()=>{
  const {runtime,event,counts}=runtimeFixture({dryRun:true});
  assert.equal((await runtime.handleComment(event)).status,'dry-run');
  assert.equal((await runtime.handleComment(event)).reason,'DUPLICATE');
  assert.equal(counts.published,0);assert.deepEqual(counts.memory,[]);
});
test('secondary self guard and database failure prevent mutation',async()=>{
  const {runtime,event,counts}=runtimeFixture({canPublish:async()=>false});
  assert.equal((await runtime.handleComment({...event,author:{id:'owner',username:'astel.us'}})).reason,'SELF_COMMENT');
  assert.equal((await runtime.handleComment(event)).reason,'DURABLE_STORE_UNAVAILABLE');
  assert.equal(counts.published,0);
});
test('confirmed secondary reply returns text for durable persistence',async()=>{
  const {runtime,event,counts}=runtimeFixture();
  assert.deepEqual(await runtime.handleComment(event),{status:'published',replyId:'r1',replyText:'A controlled reply'});
  assert.equal((await runtime.handleComment(event)).reason,'DUPLICATE');
  assert.deepEqual(counts.memory,[{id:'r1',text:'A controlled reply'}]);assert.equal(counts.published,1);
});
test('post-mutation store failure holds source and never rolls back or retries',async()=>{
  const {runtime,event,counts}=runtimeFixture({commitThrows:true});
  assert.equal((await runtime.handleComment(event)).status,'ambiguous');
  assert.equal((await runtime.handleComment(event)).reason,'DUPLICATE');
  assert.equal(counts.published,1);assert.equal(counts.rollback,0);assert.equal(counts.held,1);assert.deepEqual(counts.memory,[]);
});
