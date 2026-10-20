const { WebSocketServer } = require("ws");

// Configure which scenario to run (S1..S7)
const SCENARIO = "S7";
const PORT = 8565;

const wss = new WebSocketServer({ port: PORT });

console.log(`Test EEW WebSocket Server running on ws://localhost:${PORT}`);
console.log(`Current Scenario: ${SCENARIO}`);

wss.on("connection", function connection(ws) {
  console.log("Client connected.");

  // Send initial 'hello'
  ws.send("hello");

  ws.on("message", function message(data) {
    const text = data.toString();
    console.log("received: %s", text);
    // Echo hb
    if (text === "hb") {
      ws.send("hb");
    }
  });

  // Start scenario after 2 seconds
  setTimeout(() => runScenario(ws, SCENARIO), 2000);
});

function sendMsg(ws, msgObj) {
  if (ws.readyState !== 1) return;
  const payload = {
    channel: "eew",
    message: msgObj,
  };
  ws.send(JSON.stringify(payload));
  console.log(
    `Sent report: Serial ${msgObj.Serial}, Final: ${msgObj.Flag.is_final}, Cancel: ${msgObj.Flag.is_cancel}`,
  );
}

function addHours(date, hours) {
  date.setTime(date.getTime() + hours * 60 * 60 * 1000);

  return date;
}

function generateTime(offsetSec = 0) {
  const d = addHours(new Date(), 9 - offsetSec / 3600);
  // Return format: 2026-07-31T07:50:30+09:00
  return d.toISOString().replace("Z", "+09:00");
}

function generateEventId() {
  // Format YYYYMMDDHHMMSS
  const d = new Date();
  return (
    d.getFullYear() +
    String(d.getMonth() + 1).padStart(2, "0") +
    String(d.getDate()).padStart(2, "0") +
    String(d.getHours()).padStart(2, "0") +
    String(d.getMinutes()).padStart(2, "0") +
    String(d.getSeconds()).padStart(2, "0")
  );
}

function createBaseMsg(eventId, serial, isFinal, isCancel, isWarning = false) {
  return {
    Title: isWarning ? "緊急地震速報（警報）" : "緊急地震速報（予報）",
    OriginDateTime: generateTime(),
    ReportDateTime: generateTime(),
    EventID: eventId,
    Serial: serial,
    Hypocenter: {
      Code: 510,
      Name: "京都府北部",
      Coordinate: [135.3, 35.3],
      Depth: "10km",
      Description: "TEST",
    },
    Intensity: "1",
    Magnitude: "2.9",
    Flag: { is_final: isFinal, is_cancel: isCancel, is_training: false },
    Forecast: [],
    Text: "",
  };
}

async function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// ─── Scenario S7 data: 2026-10-16 千島列島 false alarm ────────────────────────
const S7_REPORTS = [
  [1, 17, "12:37:38", 147.6, 44.6, "10km", "6.2", "3"],
  [2, 18, "12:37:38", 147.6, 44.6, "10km", "6.7", "不明"],
  [3, 19, "12:37:14", 148.9, 46.4, "140km", "6.5", "3"],
  [4, 19, "12:37:04", 149.9, 46.6, "180km", "6.6", "不明"],
  [5, 20, "12:36:56", 150.5, 47.3, "110km", "6.7", "2"],
  [6, 21, "12:36:56", 150.5, 47.3, "110km", "6.7", "2"],
  [7, 22, "12:36:48", 151.1, 47.3, "10km", "7.4", "2"],
  [8, 23, "12:36:42", 151.9, 47.6, "120km", "6.9", "2"],
  [9, 24, "12:36:32", 152.3, 48.1, "10km", "7.6", "2"],
  [10, 25, "12:36:31", 152.8, 48.2, "90km", "7.2", "2"],
  [11, 30, "12:36:28", 153.2, 48.3, "100km", "7.2", "2"],
  [12, 30, "12:36:28", 153.2, 48.3, "100km", "6.7", "1"],
  [13, 34, "12:36:27", 153.4, 48.2, "140km", "7.3", "2"],
  [14, 54, "12:36:27", 153.4, 48.2, "140km", "7.3", "2"],
  [15, 73, "12:36:27", 153.4, 48.2, "140km", "9.9", "2"],
  [16, 93, "12:36:27", 153.4, 48.2, "140km", "9.9", "2"],
  [17, 112, "12:36:27", 153.4, 48.2, "140km", "9.9", 17],
  [18, 132, "12:36:27", 153.4, 48.2, "140km", "9.9", 17],
  [19, 151, "12:36:27", 153.4, 48.2, "140km", "9.9", 19],
  [20, 171, "12:36:27", 153.4, 48.2, "140km", "9.9", 19],
  [21, 191, "12:36:27", 153.4, 48.2, "140km", "9.9", 19],
  [22, 211, "12:36:27", 153.4, 48.2, "140km", "9.9", 19],
  [23, 231, "12:36:27", 153.4, 48.2, "140km", "9.9", 19],
  [24, 251, "12:36:27", 153.4, 48.2, "140km", "9.9", 19],
  [25, 271, "12:36:27", 153.4, 48.2, "140km", "9.9", 19],
  [26, 291, "12:36:27", 153.4, 48.2, "140km", "9.9", 19],
  [27, 311, "12:36:27", 153.4, 48.2, "140km", "9.9", 19],
  [28, 331, "12:36:27", 153.4, 48.2, "140km", "9.9", 19],
  [29, 351, "12:36:27", 153.4, 48.2, "140km", "9.9", 19],
  [30, 371, "12:36:27", 153.4, 48.2, "140km", "9.9", 19],
  [31, 391, "12:36:27", 153.4, 48.2, "140km", "9.9", 19],
  [32, 411, "12:36:27", 153.4, 48.2, "140km", "9.9", 19],
  [33, 431, "12:36:27", 153.4, 48.2, "140km", "9.9", 19],
  [34, 451, "12:36:27", 153.4, 48.2, "140km", "9.9", 19],
  [35, 471, "12:36:27", 153.4, 48.2, "140km", "9.9", 19],
  [36, 491, "12:36:27", 153.4, 48.2, "140km", "9.9", 19],
  [37, 511, "12:36:27", 153.4, 48.2, "140km", "9.9", 19],
  [38, 531, "12:36:27", 153.4, 48.2, "140km", "9.9", 19],
  [39, 551, "12:36:27", 153.4, 48.2, "140km", "9.9", 19],
  [40, 571, "12:36:27", 153.4, 48.2, "140km", "9.9", 19],
  [41, 591, "12:36:27", 153.4, 48.2, "140km", "9.9", 19],
  [42, 600, "12:36:27", 153.4, 48.2, "140km", "9.9", 19],
];

// Forecast area names -> JMA area codes (public/jma-area-codes.csv).
const S7_AREA_CODES = {
  "根室地方北部": 165,
  "根室地方中部": 166,
  "根室地方南部": 167,
  "網走地方": 140,
  "北見地方": 141,
  "釧路地方北部": 160,
  "紋別地方": 142,
  "釧路地方中南部": 161,
  "宗谷地方北部": 135,
  "宗谷地方南部": 136,
  "上川地方北部": 125,
  "空知地方南部": 122,
  "胆振地方中東部": 146,
  "石狩地方中部": 101,
  "十勝地方北部": 155,
  "上川地方中部": 126,
  "留萌地方中北部": 130,
  "十勝地方中部": 156,
  "北海道利尻礼文": 139,
  "十勝地方南部": 157,
  "上川地方南部": 127,
  "留萌地方南部": 131,
  "空知地方北部": 120,
  "空知地方中部": 121,
  "日高地方西部": 150,
  "石狩地方北部": 100,
  "日高地方東部": 152,
  "日高地方中部": 151,
  "石狩地方南部": 102,
  "後志地方北部": 115,
  "渡島地方東部": 106,
  "胆振地方西部": 145,
  "後志地方西部": 117,
  "後志地方東部": 116,
  "青森県下北地方": 203,
  "青森県三八上北地方": 202,
  "渡島地方北部": 105,
  "青森県津軽北部": 200,
  "岩手県内陸北部": 212,
  "檜山地方": 110,
  "渡島地方西部": 107,
  "岩手県沿岸北部": 210,
  "秋田県沿岸北部": 230,
  "宮城県中部": 222,
  "宮城県北部": 220,
  "北海道奥尻島": 119,
  "青森県津軽南部": 201,
  "岩手県沿岸南部": 211,
  "秋田県内陸北部": 232,
  "岩手県内陸南部": 213,
  "秋田県沿岸南部": 231,
  "秋田県内陸南部": 233,
  "宮城県南部": 221,
  "福島県中通り": 250,
  "山形県庄内地方": 240,
  "山形県村山地方": 242,
  "福島県浜通り": 251,
  "山形県最上地方": 241,
  "山形県置賜地方": 243,
  "新潟県下越地方": 372,
  "福島県会津": 252,
  "栃木県北部": 310,
  "新潟県佐渡": 375,
  "栃木県南部": 311,
  "茨城県北部": 300,
  "新潟県中越地方": 371,
  "茨城県南部": 301,
  "群馬県北部": 320,
  "千葉県北東部": 340,
  "新潟県上越地方": 370,
  "群馬県南部": 321,
  "埼玉県北部": 330,
  "埼玉県南部": 331,
  "千葉県北西部": 341,
  "石川県能登地方": 390,
  "東京都２３区": 350,
  "長野県北部": 420,
  "神奈川県東部": 360,
  "千葉県南部": 342,
  "長野県中部": 421,
  "山梨県中・西部": 411,
  "埼玉県秩父地方": 332,
  "東京都多摩東部": 351,
  "富山県東部": 380,
  "神奈川県西部": 361,
  "富山県西部": 381,
  "山梨県東部・富士五湖": 412,
  "石川県加賀地方": 391,
  "岐阜県飛騨地方": 430,
  "静岡県東部": 441,
  "静岡県伊豆地方": 440,
  "長野県南部": 422,
  "伊豆大島": 355,
  "新島": 356,
  "静岡県中部": 442,
  "岐阜県美濃中西部": 432,
  "三宅島": 357,
  "神津島": 354,
  "愛知県西部": 451,
  "静岡県西部": 443,
  "東京都多摩西部": 352,
  "岐阜県美濃東部": 431,
  "福井県嶺北": 400,
  "愛知県東部": 450,
  "福井県嶺南": 401,
};

const S7_FORECASTS = {
  1: [
    // 震度４程度 -> From 4 / To 4
    ["震度４程度", ["根室地方北部"]],
  ],
  17: [
    // 震度５弱から７程度 -> From 5- / To 7
    ["震度５弱から７程度", ["根室地方北部"]],
    // 震度４から７程度 -> From 4 / To 7
    ["震度４から７程度", ["根室地方中部", "根室地方南部", "網走地方", "北見地方", "釧路地方北部", "紋別地方", "釧路地方中南部", "宗谷地方北部", "宗谷地方南部", "上川地方北部", "空知地方南部", "胆振地方中東部", "石狩地方中部"]],
    // 震度３から７程度 -> From 3 / To 7
    ["震度３から７程度", ["十勝地方北部", "上川地方中部", "留萌地方中北部", "十勝地方中部", "北海道利尻礼文", "十勝地方南部", "上川地方南部", "留萌地方南部", "空知地方北部", "空知地方中部", "日高地方西部", "石狩地方北部", "日高地方東部", "日高地方中部", "石狩地方南部", "後志地方北部", "渡島地方東部"]],
    // 震度３から６強程度 -> From 3 / To 6+
    ["震度３から６強程度", ["胆振地方西部", "後志地方西部", "後志地方東部", "青森県下北地方", "青森県三八上北地方"]],
    // 震度３から６弱程度 -> From 3 / To 6-
    ["震度３から６弱程度", ["渡島地方北部", "青森県津軽北部", "岩手県内陸北部"]],
    // 震度２から６弱程度 -> From 2 / To 6-
    ["震度２から６弱程度", ["檜山地方", "渡島地方西部", "岩手県沿岸北部", "秋田県沿岸北部", "宮城県中部", "宮城県北部"]],
    // 震度２から５強程度 -> From 2 / To 5+
    ["震度２から５強程度", ["北海道奥尻島", "青森県津軽南部", "岩手県沿岸南部", "秋田県内陸北部", "岩手県内陸南部", "秋田県沿岸南部", "秋田県内陸南部", "宮城県南部", "福島県中通り"]],
    // 震度２から５弱程度 -> From 2 / To 5-
    ["震度２から５弱程度", ["山形県庄内地方", "山形県村山地方", "福島県浜通り"]],
    // 震度１から５弱程度 -> From 1 / To 5-
    ["震度１から５弱程度", ["山形県最上地方"]],
    // 震度１から４程度 -> From 1 / To 4
    ["震度１から４程度", ["山形県置賜地方", "新潟県下越地方", "福島県会津", "栃木県北部", "新潟県佐渡", "栃木県南部", "茨城県北部", "新潟県中越地方", "茨城県南部", "群馬県北部", "千葉県北東部", "新潟県上越地方", "群馬県南部", "埼玉県北部", "埼玉県南部", "千葉県北西部", "石川県能登地方", "東京都２３区", "長野県北部"]],
    // 震度から４程度 -> From 0 / To 4
    ["震度から４程度", ["神奈川県東部", "千葉県南部", "長野県中部", "山梨県中・西部"]],
    // 震度から３程度 -> From 0 / To 3
    ["震度から３程度", ["埼玉県秩父地方", "東京都多摩東部", "富山県東部", "神奈川県西部", "富山県西部", "山梨県東部・富士五湖", "石川県加賀地方", "岐阜県飛騨地方", "静岡県東部", "静岡県伊豆地方"]],
    // 震度程度 -> From 0 / To 0
    ["震度程度", ["長野県南部", "伊豆大島", "新島", "静岡県中部", "岐阜県美濃中西部", "三宅島", "神津島", "愛知県西部", "静岡県西部"]],
  ],
  19: [
    // 震度５弱から７程度 -> From 5- / To 7
    ["震度５弱から７程度", ["根室地方北部", "根室地方南部"]],
    // 震度４から７程度 -> From 4 / To 7
    ["震度４から７程度", ["網走地方", "根室地方中部", "釧路地方北部", "紋別地方", "北見地方", "宗谷地方北部", "宗谷地方南部", "釧路地方中南部", "上川地方北部", "留萌地方中北部", "十勝地方北部", "空知地方南部", "日高地方西部", "石狩地方北部", "胆振地方中東部", "石狩地方中部"]],
    // 震度３から７程度 -> From 3 / To 7
    ["震度３から７程度", ["上川地方中部", "十勝地方中部", "北海道利尻礼文", "上川地方南部", "留萌地方南部", "空知地方北部", "十勝地方南部", "空知地方中部", "日高地方東部", "日高地方中部", "石狩地方南部", "後志地方北部", "胆振地方西部", "後志地方西部", "後志地方東部", "渡島地方東部", "渡島地方北部", "青森県下北地方", "檜山地方", "渡島地方西部", "青森県津軽北部", "青森県三八上北地方", "岩手県沿岸北部", "岩手県内陸北部"]],
    // 震度２から７程度 -> From 2 / To 7
    ["震度２から７程度", ["青森県津軽南部", "秋田県沿岸北部", "宮城県中部", "宮城県北部"]],
    // 震度２から６強程度 -> From 2 / To 6+
    ["震度２から６強程度", ["北海道奥尻島", "岩手県沿岸南部", "秋田県内陸北部", "岩手県内陸南部", "秋田県沿岸南部", "秋田県内陸南部", "山形県庄内地方", "宮城県南部", "山形県村山地方", "福島県中通り"]],
    // 震度２から６弱程度 -> From 2 / To 6-
    ["震度２から６弱程度", ["福島県浜通り"]],
    // 震度１から６弱程度 -> From 1 / To 6-
    ["震度１から６弱程度", ["山形県最上地方"]],
    // 震度１から５強程度 -> From 1 / To 5+
    ["震度１から５強程度", ["山形県置賜地方", "新潟県下越地方", "福島県会津", "栃木県北部", "新潟県佐渡", "栃木県南部", "茨城県北部", "新潟県中越地方", "茨城県南部", "新潟県上越地方", "群馬県南部", "埼玉県北部", "埼玉県南部", "千葉県北西部", "石川県能登地方"]],
    // 震度１から５弱程度 -> From 1 / To 5-
    ["震度１から５弱程度", ["群馬県北部", "千葉県北東部", "東京都２３区", "長野県北部", "神奈川県東部", "千葉県南部", "長野県中部", "山梨県中・西部"]],
    // 震度から４程度 -> From 0 / To 4
    ["震度から４程度", ["埼玉県秩父地方", "東京都多摩東部", "東京都多摩西部", "富山県東部", "神奈川県西部", "富山県西部", "山梨県東部・富士五湖", "石川県加賀地方", "岐阜県飛騨地方", "静岡県東部", "静岡県伊豆地方", "長野県南部", "岐阜県美濃東部", "静岡県中部", "福井県嶺北", "岐阜県美濃中西部"]],
    // 震度程度 -> From 0 / To 0
    ["震度程度", ["伊豆大島", "新島", "三宅島", "神津島", "愛知県西部", "静岡県西部", "愛知県東部", "福井県嶺南"]],
  ],
};

// Detection time of the real event (2026-10-16 12:38:10 JST). Replays rewrite
// the times to "now" while keeping every 発生時刻 the real number of seconds
// behind its report, taken from the source table's 検知からの経過秒数 column.
const S7_DETECTION_TIME = "12:38:10";
// delayScale 1 = real time (~10.5 minutes over the whole sequence).
const S7_TIMING = { delayScale: 1 };
const S7_HYPOCENTER_NAME = "千島列島";
const S7_HYPOCENTER_CODE = 912;

/** "HH:MM:SS" -> seconds since local midnight. */
function s7SecondsSinceMidnight(clock) {
  const [hours, minutes, seconds] = String(clock).split(":").map(Number);
  return hours * 3600 + minutes * 60 + seconds;
}

/**
 * Seconds between a report's 発生時刻 and the report itself, using the source
 * clock times: 経過秒数 + (検知 12:38:10 - 発生時刻). For serial 1 that is
 * 17 + (12:38:10 - 12:37:38) = 649 s.
 */
function s7OriginDelaySec(elapsed, origin) {
  return elapsed + s7SecondsSinceMidnight(S7_DETECTION_TIME) - s7SecondsSinceMidnight(origin);
}

// ─── Scenario S7 helpers ─────────────────────────────────────────────────────

/** Maps a 震度 X / 震度 X弱 text to the internal intensity string. */
function s7Intensity(text) {
  // The JMA tables use full-width digits ("震度１から４程度").
  const normalized = String(text).replace(/[０-９]/g, (c) =>
    String.fromCharCode(c.charCodeAt(0) - 0xfee0),
  );
  const map = {
    "1": "1",
    "2": "2",
    "3": "3",
    "4": "4",
    "5弱": "5-",
    "5強": "5+",
    "6弱": "6-",
    "6強": "6+",
    "7": "7",
  };
  return map[normalized] ?? "0";
}

/** Turns "震度１から４程度" into { From: "1", To: "4" }; a missing number is 0. */
function s7ParseRange(description) {
  const body = description.replace(/^震度/, "").replace(/程度$/, "");
  if (!body.includes("から")) {
    // "震度４程度" and "震度程度" carry a single (possibly empty) value.
    const unit = s7Intensity(body);
    return { From: unit, To: unit };
  }
  const [from, to] = body.split("から");
  return { From: s7Intensity(from), To: s7Intensity(to ?? "") };
}

/** Builds the normalized Forecast entries for one 予測された震度 footnote. */
function s7BuildForecast(ref) {
  const groups = S7_FORECASTS[ref] || [];
  const forecast = [];
  for (const [description, names] of groups) {
    const { From, To } = s7ParseRange(description);
    for (const name of names) {
      forecast.push({
        Code: S7_AREA_CODES[name],
        Name: name,
        Intensity: { From, To, Description: description },
      });
    }
  }
  return forecast;
}

/**
 * S7: replays the real 2026-10-16 千島列島 sequence (EventID 20261016123810).
 * Every report keeps its original serial, elapsed time and payload; the report
 * times are rewritten to "now" and each report is sent after the real interval.
 * The 発生時刻 of each report keeps the exact gap behind it from the source
 * table (検知時刻 + 経過秒数), so the sequence stays internally consistent.
 *
 * Warnings (警報) are serials 17-42. The sequence ends with the manual
 * cancellation JMA issued, which reuses serial 37 even though 42 was last.
 */
async function runS7Scenario(ws, eventId) {
  let elapsedSec = 0;

  for (const [serial, elapsed, origin, lon, lat, depth, magnitude, intensity] of S7_REPORTS) {
    await sleep((elapsed - elapsedSec) * 1000 * S7_TIMING.delayScale);
    elapsedSec = elapsed;

    // The report is timestamped "now"; its 発生時刻 sits the source number of
    // seconds behind it, measured against the detection moment.
    const now = generateTime();
    const originOffsetSec = s7OriginDelaySec(elapsed, origin);
    const isWarning = serial >= 17;
    const msg = createBaseMsg(eventId, serial, serial === 42, false, isWarning);
    msg.Hypocenter.Name = S7_HYPOCENTER_NAME;
    msg.Hypocenter.Code = S7_HYPOCENTER_CODE;
    msg.Hypocenter.Coordinate = [lon, lat];
    msg.Hypocenter.Depth = depth;
    msg.Magnitude = magnitude;
    msg.OriginDateTime = generateTime(originOffsetSec);
    msg.ReportDateTime = now;

    if (typeof intensity === "number") {
      msg.Intensity = "7";
      msg.Forecast = s7BuildForecast(intensity);
      msg.maxLgInt = "4";
    } else {
      msg.Intensity = intensity;
      msg.Forecast = [];
    }

    sendMsg(ws, msg);
  }

  await sleep(40000 * S7_TIMING.delayScale);
  const cancel = createBaseMsg(eventId, 37, true, true, true);
  cancel.OriginDateTime = generateTime(s7OriginDelaySec(600, "12:36:27"));
  cancel.ReportDateTime = generateTime();
  cancel.Hypocenter.Name = S7_HYPOCENTER_NAME;
  cancel.Hypocenter.Code = S7_HYPOCENTER_CODE;
  cancel.Hypocenter.Coordinate = [153.4, 48.2];
  cancel.Hypocenter.Depth = "140km";
  cancel.Magnitude = "9.9";
  cancel.Intensity = "7";
  cancel.Forecast = [];
  cancel.Text = "先ほどの、緊急地震速報（地震動予報）を取り消します。";
  sendMsg(ws, cancel);
}

async function runScenario(ws, scenario) {
  const eventId1 = generateEventId();
  await sleep(2000);
  const eventId2 = generateEventId();

  if (scenario === "S1") {
    // S1: forecast, up to int 4, multiple updates, final.
    const msg = createBaseMsg(eventId1, 1, false, false);
    msg.Intensity = "2";
    msg.Magnitude = "3.5";
    sendMsg(ws, msg);

    await sleep(3000);
    msg.Serial = 2;
    msg.Intensity = "3";
    msg.Magnitude = "4.1";
    msg.Hypocenter.Depth = "20km";
    sendMsg(ws, msg);

    await sleep(3000);
    msg.Serial = 3;
    msg.Intensity = "4";
    msg.Flag.is_final = true;
    msg.Hypocenter.Depth = "10km";
    msg.Magnitude = "4.6";
    msg.Forecast = [
      {
        Code: 510,
        Name: "京都府北部",
        Intensity: { From: "4", To: "4", Description: "最大震度4" },
      },
    ];
    sendMsg(ws, msg);
  } else if (scenario === "S2") {
    // S2: forecast -> Warning (int 5- or higher) -> final.
    let msg = createBaseMsg(eventId1, 1, false, false);
    msg.Intensity = "3";
    msg.Magnitude = "4.2";
    sendMsg(ws, msg);

    await sleep(3000);
    msg = createBaseMsg(eventId1, 2, false, false, true); // Upgrade to warning
    msg.Intensity = "5-";
    msg.Magnitude = "5.4";
    msg.Forecast = [
      {
        Code: 510,
        Name: "京都府北部",
        Intensity: { From: "5-", To: "5-", Description: "最大震度5弱" },
      },
      {
        Code: 511,
        Name: "京都府南部",
        Intensity: { From: "4", To: "4", Description: "最大震度4" },
      },
    ];
    sendMsg(ws, msg);

    await sleep(3000);
    msg.Serial = 3;
    msg.Flag.is_final = true;
    sendMsg(ws, msg);
  } else if (scenario === "S3") {
    // S3: simultaneous EEWs
    let msg1 = createBaseMsg(eventId1, 1, false, false);
    msg1.Intensity = "4";
    msg1.Magnitude = "4.6";
    msg1.Forecast = [
      {
        Code: 510,
        Name: "京都府北部",
        Intensity: { From: "4", To: "4", Description: "最大震度4" },
      },
    ];
    sendMsg(ws, msg1);

    await sleep(2000);
    let msg2 = createBaseMsg(eventId2, 1, false, false);
    msg2.Hypocenter.Name = "沖縄本島近海";
    msg2.Hypocenter.Code = 850;
    msg2.Hypocenter.Coordinate = [128.0, 26.0];
    msg2.Intensity = "4";
    msg2.Magnitude = "5.2";
    msg2.Forecast = [
      {
        Code: 800,
        Name: "沖縄県本島北部",
        Intensity: { From: "4", To: "4", Description: "最大震度4" },
      },
    ];
    sendMsg(ws, msg2);

    await sleep(3000);
    msg1.Serial = 2;
    msg1.Intensity = "3";
    msg1.Magnitude = "4.1";
    msg1.Forecast = [
      {
        Code: 510,
        Name: "京都府北部",
        Intensity: { From: "3", To: "3", Description: "最大震度3" },
      },
    ];
    msg1.Flag.is_final = true;
    sendMsg(ws, msg1);

    await sleep(2000);
    msg2.Serial = 2;
    msg2.Flag.is_final = true;
    sendMsg(ws, msg2);
  } else if (scenario === "S4") {
    // S4: Warning using PLUM method (M1.0, depth 10km), final.
    let msg = createBaseMsg(eventId1, 1, false, false, true);
    msg.Magnitude = "1.0";
    msg.Hypocenter.Depth = "10km";
    msg.Intensity = "6-";
    msg.Forecast = [
      {
        Code: 510,
        Name: "京都府北部",
        Intensity: { From: "6-", To: "6-", Description: "最大震度6弱" },
      },
      {
        Code: 511,
        Name: "京都府南部",
        Intensity: { From: "5+", To: "5+", Description: "最大震度5強" },
      },
    ];
    sendMsg(ws, msg);

    await sleep(4000);
    msg.Serial = 2;
    msg.Flag.is_final = true;
    sendMsg(ws, msg);
  } else if (scenario === "S5") {
    // S5: Forecast -> Cancel report.
    let msg = createBaseMsg(eventId1, 1, false, false);
    msg.Intensity = "不明";
    sendMsg(ws, msg);

    await sleep(3000);
    msg.Serial = 2;
    msg.Flag.is_cancel = true;
    msg.Forecast = [];
    sendMsg(ws, msg);
  } else if (scenario === "S6") {
    // S6: deep focus
    let msg = createBaseMsg(eventId1, 1, false, false);
    msg.Intensity = "不明";
    msg.Forecast = [];
    msg.OriginDateTime = generateTime(40);
    msg.Hypocenter.Depth = "360km";
    msg.Hypocenter.Name = "日本海北部";
    msg.Hypocenter.Code = 907;
    msg.Hypocenter.Coordinate = [136.0, 43.5];
    msg.Magnitude = "7.0";
    sendMsg(ws, msg);

    await sleep(3000);
    msg.Serial = 2;
    msg.Flag.is_final = true;
    sendMsg(ws, msg);
  } else if (scenario === "S7") {
    // S7: 2026-10-16 千島列島 false-alarm warning sequence and its cancellation.
    await runS7Scenario(ws, eventId1);
  }
}
