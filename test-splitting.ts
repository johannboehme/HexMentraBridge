// Unit test for the _showText chunking logic extracted from DisplayManager

const CHUNK_SIZE = 250;

function splitText(text: string): string[] {
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

  return chunks;
}

// ─── Tests ───

function test(name: string, fn: () => void) {
  try {
    fn();
    console.log(`✅ ${name}`);
  } catch (e: any) {
    console.error(`❌ ${name}: ${e.message}`);
  }
}

function assertEqual(a: string, b: string, msg: string) {
  if (a !== b) {
    // Show where they differ
    for (let i = 0; i < Math.max(a.length, b.length); i++) {
      if (a[i] !== b[i]) {
        throw new Error(`${msg}\n  First diff at index ${i}:\n  Expected: ...${b.substring(Math.max(0,i-20), i+20)}...\n  Got:      ...${a.substring(Math.max(0,i-20), i+20)}...`);
      }
    }
    throw new Error(`${msg}\n  Lengths differ: got ${a.length}, expected ${b.length}`);
  }
}

// Test 1: Short text — no splitting
test('Short text stays intact', () => {
  const input = 'Hello world';
  const chunks = splitText(input);
  if (chunks.length !== 1) throw new Error(`Expected 1 chunk, got ${chunks.length}`);
  assertEqual(chunks[0], input, 'Chunk mismatch');
});

// Test 2: Exactly CHUNK_SIZE — no splitting
test('Exactly 250 chars stays intact', () => {
  const input = 'A'.repeat(250);
  const chunks = splitText(input);
  if (chunks.length !== 1) throw new Error(`Expected 1 chunk, got ${chunks.length}`);
  assertEqual(chunks[0], input, 'Chunk mismatch');
});

// Test 3: Reassembly — the critical test!
test('Reassembled chunks equal original (numbered sentences)', () => {
  const input = 'Satz 1: Der schnelle braune Fuchs springt ueber den faulen Hund. Satz 2: Berlin ist die Hauptstadt von Deutschland. Satz 3: Die Antwort auf alles ist zweiundvierzig. Satz 4: Kaffee ohne Milch ist wie morgens ohne Sonne. Satz 5: Der Mond dreht sich einmal im Monat um die Erde. Satz 6: Programmieren ist die Kunst Fehler zu erschaffen die vorher nicht da waren. Satz 7: Ein Pinguin kann nicht fliegen aber er kann sehr gut schwimmen. Satz 8: Die beste Zeit einen Baum zu pflanzen war vor zwanzig Jahren die zweitbeste ist jetzt. Satz 9: Wer im Glashaus sitzt sollte nicht mit Steinen werfen. Satz 10: Ende des Tests alles angekommen dann funktioniert das Splitting korrekt.';

  const chunks = splitText(input);
  console.log(`    Input length: ${input.length}`);
  console.log(`    Chunks: ${chunks.length}`);
  for (let i = 0; i < chunks.length; i++) {
    console.log(`    Chunk ${i+1} (${chunks[i].length} chars): "${chunks[i].substring(0, 60)}..."`);
  }

  // Reassemble with single space (since trimStart removes leading spaces)
  const reassembled = chunks.join(' ');
  assertEqual(reassembled, input, 'Reassembly mismatch!');
});

// Test 4: Reassembly with trimStart simulation
test('Reassembly accounting for trimStart behavior', () => {
  const input = 'Satz 1: Der schnelle braune Fuchs springt ueber den faulen Hund. Satz 2: Berlin ist die Hauptstadt von Deutschland. Satz 3: Die Antwort auf alles ist zweiundvierzig. Satz 4: Kaffee ohne Milch ist wie morgens ohne Sonne. Satz 5: Der Mond dreht sich einmal im Monat um die Erde. Satz 6: Programmieren ist die Kunst Fehler zu erschaffen die vorher nicht da waren. Satz 7: Ein Pinguin kann nicht fliegen aber er kann sehr gut schwimmen. Satz 8: Die beste Zeit einen Baum zu pflanzen war vor zwanzig Jahren die zweitbeste ist jetzt. Satz 9: Wer im Glashaus sitzt sollte nicht mit Steinen werfen. Satz 10: Ende des Tests alles angekommen dann funktioniert das Splitting korrekt.';

  const chunks = splitText(input);

  // The bug: substring(0, cut) gets text BEFORE the space at position `cut`
  // Then substring(cut) starts FROM the space
  // Then trimStart() removes that space
  // So the space that was at position `cut` is LOST
  // Let's verify by checking character-by-character

  // Simulate what the display actually shows (with page labels)
  let allChars = '';
  for (let i = 0; i < chunks.length; i++) {
    allChars += chunks[i];
    if (i < chunks.length - 1) allChars += ' '; // The space that trimStart ate
  }

  if (allChars === input) {
    console.log('    ✓ No characters lost when re-adding trimmed spaces');
  } else {
    // Find where they differ
    for (let i = 0; i < Math.max(allChars.length, input.length); i++) {
      if (allChars[i] !== input[i]) {
        console.log(`    ✗ Diff at index ${i}:`);
        console.log(`      Original:    "${input.substring(Math.max(0,i-30), i)}[${input[i]}]${input.substring(i+1, i+30)}"`);
        console.log(`      Reassembled: "${allChars.substring(Math.max(0,i-30), i)}[${allChars[i]}]${allChars.substring(i+1, i+30)}"`);
        break;
      }
    }
    throw new Error('Characters lost in splitting!');
  }
});

// Test 5: Check that lastIndexOf finds the RIGHT space
test('lastIndexOf space boundary analysis', () => {
  // Create text where the space at position 250 matters
  const words = 'word '.repeat(60); // 300 chars
  const input = words.trim();

  const chunks = splitText(input);
  console.log(`    Input length: ${input.length}`);
  
  for (let i = 0; i < chunks.length; i++) {
    console.log(`    Chunk ${i+1} (${chunks[i].length}): starts="${chunks[i].substring(0,20)}" ends="${chunks[i].substring(chunks[i].length-20)}"`);
    // Verify no chunk starts or ends with a space
    if (chunks[i].startsWith(' ')) console.log(`    ⚠️ Chunk ${i+1} starts with space!`);
    if (chunks[i].endsWith(' ')) console.log(`    ⚠️ Chunk ${i+1} ends with trailing space!`);
  }

  // Critical: does join recover the original?
  const recovered = chunks.join(' ');
  assertEqual(recovered, input, 'Word-boundary split lost content');
});

// Test 6: Substring boundary deep-dive
test('Substring cut-point analysis', () => {
  // Manually trace the algorithm
  const input = 'AAAA BBBB CCCC DDDD EEEE FFFF GGGG HHHH IIII JJJJ KKKK LLLL MMMM NNNN OOOO PPPP QQQQ RRRR SSSS TTTT UUUU VVVV WWWW XXXX YYYY ZZZZ 1111 2222 3333 4444 5555 6666 7777 8888 9999 0000 aaaa bbbb cccc dddd eeee ffff gggg hhhh iiii jjjj kkkk llll mmmm nnnn';

  console.log(`    Input length: ${input.length}`);
  console.log(`    Char at 250: "${input[250]}" (index 250)`);
  
  const cut = input.lastIndexOf(' ', CHUNK_SIZE);
  console.log(`    lastIndexOf(' ', 250) = ${cut}`);
  console.log(`    substring(0, ${cut}) = "${input.substring(0, cut)}"`);
  console.log(`    substring(${cut}) = "${input.substring(cut)}"`);
  console.log(`    substring(${cut}).trimStart() = "${input.substring(cut).trimStart()}"`);
  
  // The key question: is input[cut] included in chunk1 or chunk2?
  const chunk1 = input.substring(0, cut);
  const remainder = input.substring(cut).trimStart();
  
  console.log(`    chunk1 ends with: "${chunk1.substring(chunk1.length - 10)}"`);
  console.log(`    remainder starts with: "${remainder.substring(0, 10)}"`);
  console.log(`    chunk1.length + 1 + remainder.length = ${chunk1.length} + 1 + ${remainder.length} = ${chunk1.length + 1 + remainder.length}`);
  console.log(`    input.length = ${input.length}`);
  
  if (chunk1.length + 1 + remainder.length !== input.length) {
    console.log(`    ⚠️ MISMATCH! Lost ${input.length - chunk1.length - 1 - remainder.length} chars`);
  }
});

console.log('\n=== G1 Bridge Text Splitting Tests ===\n');
