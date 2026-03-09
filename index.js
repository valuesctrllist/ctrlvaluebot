const { Client, GatewayIntentBits } = require('discord.js');
const fs = require('fs');
const path = require('path');

const DATA_FILE = path.join(__dirname, 'pets.json');

const HATCH_CHANNEL_ID = process.env.HATCH_CHANNEL_ID;

// Startup catch-up
const STARTUP_CATCHUP_ENABLED = true;
const STARTUP_CATCHUP_LIMIT = 1000;

// Optional full backfill
const RUN_FULL_BACKFILL_ON_START = false;
const MAX_FULL_BACKFILL_MESSAGES = 50000;

const MUTATIONS = [
  'Rainy','Moonlit','Frozen','Electrified',
  'Lovely','Starstruck','Eclipsed','Taco','Godlike'
];

const VARIANTS = [
  'Golden','Rainbow','Shiny','Super Shiny'
];

const processedMessageIds = new Set();
const processedMessageOrder = [];
const MAX_PROCESSED_MESSAGES = 5000;

function markMessageProcessed(messageId) {
  if (processedMessageIds.has(messageId)) return;

  processedMessageIds.add(messageId);
  processedMessageOrder.push(messageId);

  if (processedMessageOrder.length > MAX_PROCESSED_MESSAGES) {
    const oldest = processedMessageOrder.shift();
    processedMessageIds.delete(oldest);
  }
}

function loadData() {
  if (!fs.existsSync(DATA_FILE)) fs.writeFileSync(DATA_FILE,'{}');
  return JSON.parse(fs.readFileSync(DATA_FILE,'utf8') || '{}');
}

function saveData(data) {
  fs.writeFileSync(DATA_FILE, JSON.stringify(data,null,2));
}

function ensurePet(data,name,type){
  if(!data[name]){
    data[name]={
      type:type,
      exists:0,
      mutations:{Normal:0},
      variants:{Normal:0},
      doubleMutations:[],
      doubleVariants:[],
      processedCombos:[]
    };
  }
}

function incrementBucket(obj,key){
  if(!obj[key]) obj[key]=0;
  obj[key]+=1;
}

function extractSerial(text){
  const m=text.match(/Serial:\s*#(\d+)/i);
  return m?parseInt(m[1]):null;
}

function splitPrefixWords(prefix){
  if(!prefix) return [];
  const words=prefix.trim().split(/\s+/);
  const result=[];

  for(let i=0;i<words.length;i++){
    if(words[i]==='Super' && words[i+1]==='Shiny'){
      result.push('Super Shiny');
      i++;
    } else {
      result.push(words[i]);
    }
  }
  return result;
}

function normalizeCombo(muts,vars,serial){
  const m=[...muts].sort().join('|')||'Normal';
  const v=[...vars].sort().join('|')||'Normal';
  return `${m}__${v}__${serial}`;
}

function buildMessageText(message){
  let text=message.content||'';

  if(message.embeds?.length){
    const e=message.embeds[0];
    text+='\n'+(e.title||'');
    text+='\n'+(e.description||'');

    if(e.fields){
      for(const f of e.fields){
        text+=`\n${f.name}: ${f.value}`;
      }
    }
  }
  return text.trim();
}

function processHatchMessage(message,data,source='LIVE'){
  if(processedMessageIds.has(message.id)){
    console.log(`[${source}] ALREADY COUNTED`);
    return false;
  }

  const text=buildMessageText(message);
  const lower=text.toLowerCase();

  if(lower.includes('secret')){
    console.log(`[${source}] IGNORED: Secret`);
    markMessageProcessed(message.id);
    return false;
  }

  if(!lower.includes('huge') && !lower.includes('giant')){
    markMessageProcessed(message.id);
    return false;
  }

  const match=text.match(/just (got|hatched) a (.+?)!/i);
  if(!match){
    markMessageProcessed(message.id);
    return false;
  }

  const drop=match[2].trim();

  let petIndex=-1;
  let petType=null;

  if(drop.includes('Huge')){
    petIndex=drop.indexOf('Huge');
    petType='Huge';
  }
  else if(drop.includes('Giant')){
    petIndex=drop.indexOf('Giant');
    petType='Giant';
  }

  const before=drop.slice(0,petIndex).trim();
  const pet=drop.slice(petIndex).trim();
  const serial=extractSerial(text);

  const words=splitPrefixWords(before);

  const foundMutations=[];
  const foundVariants=[];

  for(const w of words){
    if(MUTATIONS.includes(w)) foundMutations.push(w);
    if(VARIANTS.includes(w)) foundVariants.push(w);
  }

  if(foundMutations.length>=3) return false;
  if(foundVariants.length>=3) return false;

  if(foundMutations.length>=2 && foundVariants.length>=1) return false;
  if(foundVariants.length>=2 && foundMutations.length>=1) return false;

  ensurePet(data,pet,petType);

  if(serial && serial>data[pet].exists){
    data[pet].exists=serial;
  }

  const combo=normalizeCombo(foundMutations,foundVariants,serial);

  if(data[pet].processedCombos.includes(combo)){
    markMessageProcessed(message.id);
    return false;
  }

  data[pet].processedCombos.push(combo);

  if(foundMutations.length===0){
    incrementBucket(data[pet].mutations,'Normal');
  }
  else if(foundMutations.length===1){
    incrementBucket(data[pet].mutations,foundMutations[0]);
  }
  else{
    data[pet].doubleMutations.push(foundMutations.join(', '));
  }

  if(foundVariants.length===0){
    incrementBucket(data[pet].variants,'Normal');
  }
  else if(foundVariants.length===1){
    incrementBucket(data[pet].variants,foundVariants[0]);
  }
  else{
    data[pet].doubleVariants.push(foundVariants.join(', '));
  }

  markMessageProcessed(message.id);

  console.log(`[${source}] SAVED → ${pet} (#${serial})`);

  return true;
}

async function runStartupCatchup(){
  if(!STARTUP_CATCHUP_ENABLED) return;

  const channel=await client.channels.fetch(HATCH_CHANNEL_ID);

  const data=loadData();

  let before;
  let remaining=STARTUP_CATCHUP_LIMIT;

  while(remaining>0){

    const messages=await channel.messages.fetch({
      limit:Math.min(100,remaining),
      before
    });

    if(!messages.size) break;

    const sorted=[...messages.values()]
    .sort((a,b)=>a.createdTimestamp-b.createdTimestamp);

    for(const m of sorted){
      processHatchMessage(m,data,'CATCHUP');
      remaining--;
    }

    before=messages.last().id;
  }

  saveData(data);

  console.log("Startup catch-up finished");
}

const client=new Client({
  intents:[
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent
  ]
});

client.once('ready',async()=>{
  console.log(`Bot online as ${client.user.tag}`);

  await runStartupCatchup();
});

client.on('messageCreate',message=>{

  if(message.channel.id!==HATCH_CHANNEL_ID) return;

  const data=loadData();

  if(processHatchMessage(message,data,'LIVE')){
    saveData(data);
  }

});

client.on("error",console.error);
process.on("unhandledRejection",console.error);

client.login(process.env.DISCORD_TOKEN);