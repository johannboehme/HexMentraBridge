// Test 2: Check what actually gets displayed (with [n/total] labels)

const CHUNK_SIZE = 250;

function splitAndLabel(text: string): string[] {
  if (text.length <= CHUNK_SIZE) {
    return [text];
  }

  const chunks: string[] = [];
  let remaining = text;
  while (remaining.length > 0) {
    if (remaining.length <= CHUNK_SIZE) {
      chunks.push(remaining);
      break;
    }
    let cut = remaining.lastIndexOf(' ', CHUNK_SIZE);
    if (cut < 100) cut = CHUNK_SIZE;
    chunks.push(remaining.substring(0, cut));
    remaining = remaining.substring(cut).trimStart();
  }

  // Now add labels like the real code does
  const total = chunks.length;
  const labeled: string[] = [];
  for (let i = 0; i < total; i++) {
    const label = `[${i + 1}/${total}] `;
    labeled.push(label + chunks[i]);
  }

  return labeled;
}

// The actual test text I sent
const testText = 'Hier ist ein Testtext mit nummerierten Saetzen damit du jeden Split pruefen kannst. Satz 1: Der schnelle braune Fuchs springt ueber den faulen Hund. Satz 2: Berlin ist die Hauptstadt von Deutschland. Satz 3: Die Antwort auf alles ist zweiundvierzig. Satz 4: Kaffee ohne Milch ist wie morgens ohne Sonne. Satz 5: Der Mond dreht sich einmal im Monat um die Erde. Satz 6: Programmieren ist die Kunst Fehler zu erschaffen die vorher nicht da waren. Satz 7: Ein Pinguin kann nicht fliegen aber er kann sehr gut schwimmen. Satz 8: Die beste Zeit einen Baum zu pflanzen war vor zwanzig Jahren die zweitbeste ist jetzt. Satz 9: Wer im Glashaus sitzt sollte nicht mit Steinen werfen. Satz 10: Ende des Tests alles angekommen dann funktioniert das Splitting korrekt.';

console.log(`\nInput (${testText.length} chars):\n${testText}\n`);
console.log('=== What the glasses actually show: ===\n');

const pages = splitAndLabel(testText);
for (const page of pages) {
  console.log(`--- PAGE (${page.length} chars) ---`);
  console.log(page);
  console.log();
}

// Also check: does the label itself push content beyond what the display can show?
// G1 display is ~4 lines, monochrome, 640x400px
// With the SDK's showTextWall, it auto-formats but there's a practical limit
console.log(`\n=== Character counts per page ===`);
for (let i = 0; i < pages.length; i++) {
  console.log(`Page ${i+1}: ${pages[i].length} chars`);
}

// Now test: what if the REPLY from Hex was the long Android remote control answer?
const longReply = `OK, hier die Zusammenfassung. Es gibt mehrere realistische Wege, dein Handy von hier aus fernzusteuern:

Option 1: Tasker HTTP Server + AutoInput (bester Weg)
Tasker hat seit v6.2 einen eingebauten HTTP Server. Du kannst auf dem Handy einen HTTP-Endpunkt aufmachen, und ich schicke Befehle hin. AutoInput kann dann Taps, Swipes, Text-Eingabe und Screenshots machen. Ablauf waere:
Tasker HTTP Server auf einem Port starten (z.B. 8765)
Profile anlegen die auf HTTP Requests reagieren
Ich sende POST http://handy-ip:8765/tap?x=500&y=300 AutoInput tippt
Ich sende GET /screenshot Tasker macht Screenshot und schickt ihn zurueck
Problem: Handy muss erreichbar sein (gleiches Netz oder Tailscale/WireGuard)

Option 2: Join + Tasker Tasks (schon installiert)
Du hast Join bereits. Join kann Text-Commands an Tasker schicken. Ich koennte vordefinierte Tasks triggern:
Ich sende per Join API text: autoinput_tap 500 300 Tasker parst das AutoInput tippt
Weniger flexibel, aber funktioniert uebers Internet ohne Portfreigabe

Option 3: ADB over Network
ADB Wireless Debugging aktivieren, dann kann ich vom VPS aus adb connect und mit adb shell input tap x y direkt Taps senden. Braucht kein Tasker, kein AutoInput. Aber: ADB-Verbindung ueber Internet ist ein Sicherheitsrisiko (sollte ueber VPN/Tunnel laufen).

Meine Empfehlung: Option 2 (Join) als Quick-Win, weil du es schon hast. Fuer volle Fernsteuerung mit Screenshot-Feedback waere Option 1 (Tasker HTTP Server) am maechtigsten. Willst du einen der Wege aufsetzen?`;

console.log(`\n\n=== Long reply splitting (${longReply.length} chars) ===\n`);
const longPages = splitAndLabel(longReply);
for (const page of longPages) {
  console.log(`--- PAGE (${page.length} chars) ---`);
  console.log(page);
  console.log();
}

console.log(`Total pages: ${longPages.length}`);
console.log(`At 8s per page = ${longPages.length * 8}s total display time`);
