const http = require("http");
const fs = require("fs");
const path = require("path");
const { Client, GatewayIntentBits } = require("discord.js");

http.createServer((req, res) => {
  res.writeHead(200);
  res.end("Bot is running");
}).listen(process.env.PORT || 3000);

const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
const HATCH_CHANNEL_ID = process.env.HATCH_CHANNEL_ID;
const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const GITHUB_REPO = process.env.GITHUB_REPO;

const LOCAL_PETS_FILE = path.join(__dirname, "pets.json");
const LOCAL_PROCESSED_FILE = path.join(__dirname, "processedMessages.json");

const STARTUP_CATCHUP_ENABLED = true;
const STARTUP_CATCHUP_LIMIT = 1000;

const FULL_BACKFILL_MODE = false;
const FULL_BACKFILL_LIMIT = 50000;
const BACKFILL_SAVE_EVERY = 1000;

const PETS_FILE_PATH = "pets.json";
const PROCESSED_FILE_PATH = "processedMessages.json";

const MUTATIONS = [
  "Rainy",
  "Moonlit",
  "Frozen",
  "Electrified",
  "Lovely",
  "Starstruck",
  "Eclipsed",
  "Taco",
  "Godlike"
];

const VARIANTS = [
  "Golden",
  "Rainbow",
  "Shiny",
  "Super Shiny"
];

const processedMessageIds = new Set();

let petsData = {};
let processedMessagesData = [];
let petsSha = null;
let processedSha = null;

console.log("Starting bot...");

function safeReadJson(localPath, fallback) {
  try {
    if (!fs.existsSync(localPath)) return fallback;
    const raw = fs.readFileSync(localPath, "utf8");
    return JSON.parse(raw || JSON.stringify(fallback));
  } catch {
    return fallback;
  }
}

function writeLocalJson(localPath, data) {
  fs.writeFileSync(localPath, JSON.stringify(data, null, 2));
}

function makeBucket() {
  return {
    count: 0,
    highestSerial: 0
  };
}

function sumBucketMap(obj) {
  let total = 0;
  for (const key of Object.keys(obj || {})) {
    total += obj[key]?.count || 0;
  }
  return total;
}

function recalcExists(petObj) {
  petObj.exists =
    (petObj.normal?.count || 0) +
    sumBucketMap(petObj.mutations) +
    sumBucketMap(petObj.variants) +
    sumBucketMap(petObj.combos) +
    sumBucketMap(petObj.doubleMutations) +
    sumBucketMap(petObj.doubleVariants);
}

async function loadRemoteData() {
  petsData = safeReadJson(LOCAL_PETS_FILE, {});
  processedMessagesData = safeReadJson(LOCAL_PROCESSED_FILE, []);

  processedMessageIds.clear();

  for (const id of processedMessagesData) {
    processedMessageIds.add(id);
  }

  console.log("Loaded pets + processed messages");
}

async function saveRemoteData(reason = "Update hatch tracker data") {
  try {
    writeLocalJson(LOCAL_PETS_FILE, petsData);
    writeLocalJson(LOCAL_PROCESSED_FILE, processedMessagesData);

    console.log("Saved data locally:", reason);
  } catch (err) {
    console.error("Save failed:", err);
  }
}

function ensurePet(data, name, type) {
  if (!data[name]) {
    data[name] = {
      type,
      exists: 0,
      normal: makeBucket(),
      mutations: {},
      variants: {},
      combos: {},
      doubleMutations: {},
      doubleVariants: {},
      processedCombos: []
    };
  }
}

function extractSerial(text) {
  const m = text.match(/Serial:\s*#(\d+)/i);
  return m ? parseInt(m[1], 10) : null;
}

function splitPrefixWords(prefix) {
  if (!prefix) return [];

  const words = prefix.trim().split(/\s+/);
  const result = [];

  for (let i = 0; i < words.length; i++) {
    if (words[i] === "Super" && words[i + 1] === "Shiny") {
      result.push("Super Shiny");
      i++;
    } else {
      result.push(words[i]);
    }
  }

  return result;
}

function buildMessageText(message) {
  let text = message.content || "";

  if (message.embeds?.length) {
    const e = message.embeds[0];
    text += "\n" + (e.title || "");
    text += "\n" + (e.description || "");

    if (e.fields) {
      for (const f of e.fields) {
        text += `\n${f.name}: ${f.value}`;
      }
    }
  }

  return text;
}

function processHatchMessage(message, data) {
  const text = buildMessageText(message);

  if (!text.toLowerCase().includes("huge") && !text.toLowerCase().includes("giant")) {
    return false;
  }

  const match = text.match(/just (got|hatched) a (.+?)!/i);

  if (!match) {
    console.log("Message did not match hatch format");
    return false;
  }

  const drop = match[2].trim();

  let petIndex = drop.indexOf("Huge");
  if (petIndex === -1) petIndex = drop.indexOf("Giant");

  if (petIndex === -1) return false;

  const before = drop.slice(0, petIndex).trim();
  const pet = drop.slice(petIndex).trim();

  const serial = extractSerial(text);
  const words = splitPrefixWords(before);

  const foundMutations = [];
  const foundVariants = [];

  for (const w of words) {
    if (MUTATIONS.includes(w)) foundMutations.push(w);
    if (VARIANTS.includes(w)) foundVariants.push(w);
  }

  ensurePet(data, pet, "Huge");

  data[pet].normal.count += 1;

  if (serial && serial > data[pet].normal.highestSerial) {
    data[pet].normal.highestSerial = serial;
  }

  recalcExists(data[pet]);

  console.log(`[LIVE] SAVED -> ${pet} (#${serial || "?"})`);

  return true;
}

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent
  ]
});

client.once("ready", async () => {
  console.log(`Bot online as ${client.user.tag}`);

  await loadRemoteData();
});

client.on("messageCreate", async (message) => {

  if (message.channel.id !== HATCH_CHANNEL_ID) return;
  if (message.author.bot) return;

  console.log("----- MESSAGE SEEN -----");

  const rawText = buildMessageText(message);

  console.log(rawText || "[empty message]");

  const changed = processHatchMessage(message, petsData);

  if (changed) {
    await saveRemoteData("Live hatch update");
  } else {
    console.log("Message ignored by parser");
  }

});

client.login(DISCORD_TOKEN);
