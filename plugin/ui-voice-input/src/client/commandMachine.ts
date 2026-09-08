/**
 * Pure voice-command vocabulary: classify a transcribed utterance into
 * start/stop/send by matching it against configurable PHRASE patterns.
 * Zero React/DOM — the browser capture layer feeds text in and this decides the
 * action.
 *
 * Each command is a comma-separated list of phrases (e.g. "start transcription,
 * start listening, begin"). An utterance matches a command when it contains any
 * of that command's phrases as a word subsequence, tolerating a small edit per
 * word (local Whisper mangles spelling but usually keeps the words in order).
 * The content AFTER the matched phrase is the captured prompt.
 */

/** The three hands-free commands, each a comma-separated list of phrases. */
export interface CommandConfig {
  /** Start capturing the prompt. */
  listen: string
  /** Pause capture and keep the accumulated text as a draft. */
  stop: string
  /** Send the captured prompt. */
  send: string
}

/** Which command an utterance matches, if any. */
export type CommandKind = 'listen' | 'stop' | 'send' | null

/** One utterance's classification: the matched command and the content after it. */
export interface Classification {
  kind: CommandKind
  /** The utterance text following the matched phrase (trimmed). */
  payload: string
}

/** Command evaluation order: the distinguishing phrases rarely overlap. */
const COMMAND_ORDER = ['listen', 'send', 'stop'] as const

/** Lowercase, strip diacritics, and split into alphanumeric words (punctuation removed).
 * Diacritics are stripped first so "gravação" and "gravacao" compare equal — the
 * accents would otherwise split a word into two tokens and break phrase matching. */
function tokens(text: string): string[] {
  return text
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean)
}

/** Levenshtein distance between two words, early-exiting past `max`. */
function editDistance(a: string, b: string, max: number): number {
  if (Math.abs(a.length - b.length) > max) return max + 1
  const previous = new Array<number>(b.length + 1)
  for (let j = 0; j <= b.length; j++) previous[j] = j
  for (let i = 1; i <= a.length; i++) {
    // The diagonal (d[i-1][j-1]) must be captured from the previous row BEFORE
    // this row overwrites the row head; reading previous[j-1] here instead would
    // corrupt the substitution cost and inflate every distance.
    let prevDiag = previous[0] ?? 0
    previous[0] = i
    let rowMin = previous[0]
    for (let j = 1; j <= b.length; j++) {
      const oldTop = previous[j] ?? 0
      const next = Math.min(
        oldTop + 1,
        (previous[j - 1] ?? 0) + 1,
        prevDiag + (a[i - 1] === b[j - 1] ? 0 : 1),
      )
      prevDiag = oldTop
      previous[j] = next
      rowMin = Math.min(rowMin, next)
    }
    if (rowMin > max) return max + 1
  }
  return previous[b.length] ?? max + 1
}

/** Tolerate one extra edit for long words (e.g. "transcription"). */
function tolerance(word: string): number {
  return word.length >= 8 ? 2 : 1
}

/** Split a comma-separated phrase list into trimmed non-empty phrases. */
function splitPhrases(list: string): string[] {
  return list
    .split(',')
    .map(phrase => phrase.trim())
    .filter(phrase => phrase !== '')
}

/**
 * Whether the utterance contains the phrase as an in-order word subsequence.
 * @param text - the utterance.
 * @param phrase - one phrase (e.g. "start transcription").
 * @returns true when every phrase word appears, in order, within the text.
 */
function containsPhrase(text: string, phrase: string): boolean {
  const textWords = tokens(text)
  const phraseWords = tokens(phrase)
  if (phraseWords.length === 0) return false
  let ti = 0
  for (const pw of phraseWords) {
    let found = false
    while (ti < textWords.length) {
      if (editDistance(textWords[ti] ?? '', pw, tolerance(pw)) <= tolerance(pw)) {
        found = true
        ti += 1
        break
      }
      ti += 1
    }
    if (!found) return false
  }
  return true
}

/**
 * Return the text following the matched phrase's last word, so the trigger
 * words are dropped and any leading filler ("ok", "please") is ignored.
 * @param text - the utterance.
 * @param phrase - the matched phrase.
 * @returns the trimmed content after the phrase.
 */
function payloadAfterPhrase(text: string, phrase: string): string {
  const textWords = tokens(text)
  const phraseWords = tokens(phrase)
  let ti = 0
  let last = -1
  for (const pw of phraseWords) {
    let found = false
    while (ti < textWords.length) {
      if (editDistance(textWords[ti] ?? '', pw, tolerance(pw)) <= tolerance(pw)) {
        found = true
        last = ti
        ti += 1
        break
      }
      ti += 1
    }
    if (!found) return text.trim()
  }
  const words = text.split(/\s+/).filter(Boolean)
  return words.slice(last + 1).join(' ').replace(/[ ,.;:!?]+$/, '').trim()
}

/**
 * Classify one transcribed utterance against a command's phrase list.
 * @param text - the transcribed utterance.
 * @param phraseList - the command's comma-separated phrases.
 * @returns the content after the first matching phrase, or null when none match.
 */
function matchCommand(text: string, phraseList: string): string | null {
  for (const phrase of splitPhrases(phraseList)) {
    if (containsPhrase(text, phrase)) return payloadAfterPhrase(text, phrase)
  }
  return null
}

/**
 * Classify one transcribed utterance against the command set.
 * @param text - the transcribed utterance.
 * @param config - the configured command phrase lists.
 * @returns the matched command kind and the content following its phrase (the
 * text itself otherwise) when no command matches.
 */
export function classify(text: string, config: CommandConfig): Classification {
  for (const kind of COMMAND_ORDER) {
    const payload = matchCommand(text, config[kind])
    if (payload !== null) return { kind, payload }
  }
  return { kind: null, payload: text.trim() }
}
