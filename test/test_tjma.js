const fs = require('fs');

const csvText = fs.readFileSync('../public/tjma2001.csv', 'utf8');

let travelTimeData = {};
const lines = csvText.trim().split('\n');
for (let i = 1; i < lines.length; i++) {
  if (!lines[i]) continue;
  const [depth, distance, p_time, s_time] = lines[i].split(',').map(Number);
  if (!travelTimeData[depth]) {
    travelTimeData[depth] = [];
  }
  travelTimeData[depth].push({ distance, p_time, s_time });
}

function getTravelDistance(depth, time, phase) {
  if (!travelTimeData?.[depth]) return 0;
  
  const data = travelTimeData[depth];
  
  let prev = data[0];
  for (let i = 1; i < data.length; i++) {
    const curr = data[i];
    const prevTime = phase === 'P' ? prev.p_time : prev.s_time;
    const currTime = phase === 'P' ? curr.p_time : curr.s_time;
    
    if (time >= prevTime && time <= currTime) {
      if (currTime === prevTime) return prev.distance;
      const ratio = (time - prevTime) / (currTime - prevTime);
      return prev.distance + ratio * (curr.distance - prev.distance);
    }
    prev = curr;
  }
  
  const lastTime = phase === 'P' ? prev.p_time : prev.s_time;
  if (time > lastTime) {
    return prev.distance;
  }
  
  return 0;
}

console.log("depth=10, time=1.0 (should be 0, before wave hits surface):", getTravelDistance(10, 1.0, 'P'));
console.log("depth=10, time=1.773 (should be 0):", getTravelDistance(10, 1.773, 'P'));
console.log("depth=10, time=1.7905 (should be around 1, halfway between 1.773 and 1.808 for distance 0 to 2):", getTravelDistance(10, 1.7905, 'P'));
console.log("depth=0, time=0 (should be 0):", getTravelDistance(0, 0, 'P'));
console.log("depth=0, time=0.208 (should be 1):", getTravelDistance(0, 0.208, 'P'));
console.log("depth=10, time=10000 (should be 2000, max out):", getTravelDistance(10, 10000, 'P'));
