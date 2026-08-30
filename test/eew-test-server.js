const { WebSocketServer } = require("ws");

// Configure which scenario to run (S1, S2, S3, S4, S5, S6)
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
    msg.Hypocenter.Depth = "410km";
    msg.Magnitude = "5.8";
    sendMsg(ws, msg);

    await sleep(3000);
    msg.Serial = 2;
    msg.Flag.is_final = true;
    sendMsg(ws, msg);
  } else if (scenario === "S7") {
    // S7: full real extract
    await sleep(3000);
    sendMsg(ws, {
      Title: '緊急地震速報（予報）',
      OriginDateTime: '2026-08-30T00:17:05+09:00',
      ReportDateTime: '2026-08-30T00:17:15+09:00',
      EventID: '20260830001711',
      Serial: 1,
      Hypocenter: {
        Code: 473,
        Name: '千葉県東方沖',
        Coordinate: [ 140.9, 35.8 ],
        Depth: '40km',
        Description: '北緯35.8度 東経140.9度 深さ約40km'
      },
      Intensity: '3',
      Magnitude: '4.4',
      Flag: { is_final: false, is_cancel: false, is_training: false },
      Forecast: [],
      Text: ''
    });
    
    await sleep(800);
    sendMsg(ws, {
      Title: '緊急地震速報（予報）',
      OriginDateTime: '2026-08-30T00:17:06+09:00',
      ReportDateTime: '2026-08-30T00:17:16+09:00',
      EventID: '20260830001711',
      Serial: 2,
      Hypocenter: {
        Code: 473,
        Name: '千葉県東方沖',
        Coordinate: [ 141.0, 35.8 ],
        Depth: '30km',
        Description: '北緯35.8度 東経141.0度 深さ約30km'
      },
      Intensity: '2',
      Magnitude: '4.2',
      Flag: { is_final: false, is_cancel: false, is_training: false },
      Forecast: [],
      Text: ''
    });

    await sleep(400);
    sendMsg(ws, {
      Title: '緊急地震速報（予報）',
      OriginDateTime: '2026-08-30T00:17:06+09:00',
      ReportDateTime: '2026-08-30T00:17:16+09:00',
      EventID: '20260830001711',
      Serial: 3,
      Hypocenter: {
        Code: 473,
        Name: '千葉県東方沖',
        Coordinate: [ 140.9, 35.8 ],
        Depth: '20km',
        Description: '北緯35.8度 東経140.9度 深さ約20km'
      },
      Intensity: '3',
      Magnitude: '4.0',
      Flag: { is_final: false, is_cancel: false, is_training: false },
      Forecast: [],
      Text: ''
    });

    await sleep(200);
    sendMsg(ws, {
      Title: '緊急地震速報（予報）',
      OriginDateTime: '2026-08-30T00:17:06+09:00',
      ReportDateTime: '2026-08-30T00:17:16+09:00',
      EventID: '20260830001711',
      Serial: 4,
      Hypocenter: {
        Code: 473,
        Name: '千葉県東方沖',
        Coordinate: [ 140.9, 35.8 ],
        Depth: '30km',
        Description: '北緯35.8度 東経140.9度 深さ約30km'
      },
      Intensity: '3',
      Magnitude: '4.2',
      Flag: { is_final: false, is_cancel: false, is_training: false },
      Forecast: [],
      Text: ''
    });

    await sleep(600);
    sendMsg(ws, {
      Title: '緊急地震速報（予報）',
      OriginDateTime: '2026-08-30T00:17:06+09:00',
      ReportDateTime: '2026-08-30T00:17:17+09:00',
      EventID: '20260830001711',
      Serial: 5,
      Hypocenter: {
        Code: 473,
        Name: '千葉県東方沖',
        Coordinate: [ 140.9, 35.8 ],
        Depth: '20km',
        Description: '北緯35.8度 東経140.9度 深さ約20km'
      },
      Intensity: '3',
      Magnitude: '4.0',
      Flag: { is_final: false, is_cancel: false, is_training: false },
      Forecast: [],
      Text: ''
    });

    await sleep(100);
    sendMsg(ws, {
      Title: '緊急地震速報（予報）',
      OriginDateTime: '2026-08-30T00:17:06+09:00',
      ReportDateTime: '2026-08-30T00:17:17+09:00',
      EventID: '20260830001711',
      Serial: 6,
      Hypocenter: {
        Code: 473,
        Name: '千葉県東方沖',
        Coordinate: [ 140.9, 35.8 ],
        Depth: '20km',
        Description: '北緯35.8度 東経140.9度 深さ約20km'
      },
      Intensity: '3',
      Magnitude: '4.6',
      Flag: { is_final: false, is_cancel: false, is_training: false },
      Forecast: [],
      Text: ''
    });

    await sleep(200);
    sendMsg(ws, {
      Title: '緊急地震速報（予報）',
      OriginDateTime: '2026-08-30T00:17:06+09:00',
      ReportDateTime: '2026-08-30T00:17:17+09:00',
      EventID: '20260830001711',
      Serial: 7,
      Hypocenter: {
        Code: 473,
        Name: '千葉県東方沖',
        Coordinate: [ 140.9, 35.8 ],
        Depth: '20km',
        Description: '北緯35.8度 東経140.9度 深さ約20km'
      },
      Intensity: '3',
      Magnitude: '4.6',
      Flag: { is_final: false, is_cancel: false, is_training: false },
      Forecast: [],
      Text: ''
    });

    await sleep(100);
    sendMsg(ws, {
      Title: '緊急地震速報（予報）',
      OriginDateTime: '2026-08-30T00:17:06+09:00',
      ReportDateTime: '2026-08-30T00:17:17+09:00',
      EventID: '20260830001711',
      Serial: 8,
      Hypocenter: {
        Code: 473,
        Name: '千葉県東方沖',
        Coordinate: [ 140.9, 35.8 ],
        Depth: '20km',
        Description: '北緯35.8度 東経140.9度 深さ約20km'
      },
      Intensity: '4',
      Magnitude: '4.6',
      Flag: { is_final: false, is_cancel: false, is_training: false },
      Forecast: [
        {
          Code: 340,
          Name: "千葉県北東部",
          Intensity: {
            From: "4",
            To: "4",
            Description: "最大震度4程度"
          }
        }
      ],
      Text: ''
    });

    await sleep(3600);
    sendMsg(ws, {
      Title: '緊急地震速報（予報）',
      OriginDateTime: '2026-08-30T00:17:06+09:00',
      ReportDateTime: '2026-08-30T00:17:21+09:00',
      EventID: '20260830001711',
      Serial: 9,
      Hypocenter: {
        Code: 473,
        Name: '千葉県東方沖',
        Coordinate: [ 140.9, 35.8 ],
        Depth: '30km',
        Description: '北緯35.8度 東経140.9度 深さ約30km'
      },
      Intensity: '4',
      Magnitude: '4.7',
      Flag: { is_final: false, is_cancel: false, is_training: false },
      Forecast: [
        {
          Code: 340,
          Name: "千葉県北東部",
          Intensity: {
            From: "4",
            To: "4",
            Description: "最大震度4程度"
          }
        }
      ],
      Text: ''
    });

    await sleep(1100);
    sendMsg(ws, {
      Title: '緊急地震速報（予報）',
      OriginDateTime: '2026-08-30T00:17:06+09:00',
      ReportDateTime: '2026-08-30T00:17:22+09:00',
      EventID: '20260830001711',
      Serial: 10,
      Hypocenter: {
        Code: 473,
        Name: '千葉県東方沖',
        Coordinate: [ 140.9, 35.8 ],
        Depth: '30km',
        Description: '北緯35.8度 東経140.9度 深さ約30km'
      },
      Intensity: '4',
      Magnitude: '4.7',
      Flag: { is_final: false, is_cancel: false, is_training: false },
      Forecast: [
        {
          Code: 340,
          Name: "千葉県北東部",
          Intensity: {
            From: "4",
            To: "4",
            Description: "最大震度4程度"
          }
        }
      ],
      Text: ''
    });

    await sleep(19100);
    sendMsg(ws, {
      Title: '緊急地震速報（予報）',
      OriginDateTime: '2026-08-30T00:17:05+09:00',
      ReportDateTime: '2026-08-30T00:17:41+09:00',
      EventID: '20260830001711',
      Serial: 11,
      Hypocenter: {
        Code: 473,
        Name: '千葉県東方沖',
        Coordinate: [ 140.9, 35.8 ],
        Depth: '40km',
        Description: '北緯35.8度 東経140.9度 深さ約40km'
      },
      Intensity: '4',
      Magnitude: '4.9',
      Flag: { is_final: false, is_cancel: false, is_training: false },
      Forecast: [
        {
          Code: 340,
          Name: "千葉県北東部",
          Intensity: {
            From: "4",
            To: "4",
            Description: "最大震度4程度"
          }
        }
      ],
      Text: ''
    });

    await sleep(16200);
    sendMsg(ws, {
      Title: '緊急地震速報（予報）',
      OriginDateTime: '2026-08-30T00:17:05+09:00',
      ReportDateTime: '2026-08-30T00:17:57+09:00',
      EventID: '20260830001711',
      Serial: 12,
      Hypocenter: {
        Code: 473,
        Name: '千葉県東方沖',
        Coordinate: [ 140.9, 35.8 ],
        Depth: '40km',
        Description: '北緯35.8度 東経140.9度 深さ約40km'
      },
      Intensity: '4',
      Magnitude: '4.9',
      Flag: { is_final: true, is_cancel: false, is_training: false },
      Forecast: [
        {
          Code: 340,
          Name: "千葉県北東部",
          Intensity: {
            From: "4",
            To: "4",
            Description: "最大震度4程度"
          }
        }
      ],
      Text: ''
    });
  }
}
