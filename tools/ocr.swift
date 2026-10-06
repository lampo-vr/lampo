// vr-ocr — macOS-native helpers for the QA pre-review (compiled on demand by lib/qa.ts).
//   vr-ocr ocr <image>...      Vision text recognition (de-DE + en-US), one JSON line per image, in input order.
//                              Boxes are normalized (0–1) with a TOP-LEFT origin; each line carries per-word boxes.
//   vr-ocr spell < in.json     NSSpellChecker on {"words": [...], "text": "…", "languages": ["de", "en"]} (or a bare
//                              array): the words are checked in `languages` (those the checker has; German and English
//                              without it). → {"lang": "de", "verdicts": {word: {ok, guess}}}, `lang` NaturalLanguage's
//                              unchecked guess. A word is ok when any case variant is valid in one of the languages, or
//                              when it splits into valid compound parts (incl. "s").
//   vr-ocr lang < in.json      NaturalLanguage's hypotheses for {"text": "…"} → {"hypotheses": {"de": 0.71, …}}. Short
//                              OCR text gets wild guesses ("nb" for a German caption): lib/text/language.ts weighs them.
import AppKit
import Foundation
import NaturalLanguage
import Vision

struct Box: Codable { let x: Double; let y: Double; let w: Double; let h: Double }
struct Word: Codable { let text: String; let box: Box }
struct Line: Codable { let text: String; let conf: Float; let box: Box; let words: [Word]; let alts: [String] }
struct Page: Codable { let path: String; let width: Int; let height: Int; let lines: [Line]; let error: String? }

func topLeft(_ r: CGRect) -> Box {
  Box(x: Double(r.minX), y: Double(1 - r.maxY), w: Double(r.width), h: Double(r.height))
}

func recognize(_ path: String) -> Page {
  guard let img = NSImage(contentsOfFile: path),
    let cg = img.cgImage(forProposedRect: nil, context: nil, hints: nil)
  else { return Page(path: path, width: 0, height: 0, lines: [], error: "cannot load image") }
  let req = VNRecognizeTextRequest()
  req.recognitionLevel = .accurate
  req.usesLanguageCorrection = false
  if #available(macOS 13.0, *) { req.automaticallyDetectsLanguage = true } else { req.recognitionLanguages = ["de-DE", "en-US"] }
  req.minimumTextHeight = 0.012
  do {
    try VNImageRequestHandler(cgImage: cg, options: [:]).perform([req])
  } catch {
    return Page(path: path, width: cg.width, height: cg.height, lines: [], error: "\(error)")
  }
  var lines: [Line] = []
  for obs in req.results ?? [] {
    let cands = obs.topCandidates(3)
    guard let top = cands.first else { continue }
    let s = top.string
    var words: [Word] = []
    s.enumerateSubstrings(in: s.startIndex..<s.endIndex, options: .byWords) { sub, range, _, _ in
      guard let sub = sub, let rect = try? top.boundingBox(for: range)?.boundingBox else { return }
      words.append(Word(text: sub, box: topLeft(rect)))
    }
    lines.append(Line(text: s, conf: top.confidence, box: topLeft(obs.boundingBox), words: words, alts: cands.dropFirst().map { $0.string }))
  }
  return Page(path: path, width: cg.width, height: cg.height, lines: lines, error: nil)
}

func ocrMain(_ paths: [String]) {
  var pages = [Page?](repeating: nil, count: paths.count)
  let lock = NSLock()
  DispatchQueue.concurrentPerform(iterations: paths.count) { i in
    let p = recognize(paths[i])
    lock.lock()
    pages[i] = p
    lock.unlock()
  }
  let enc = JSONEncoder()
  for p in pages {
    if let p = p, let d = try? enc.encode(p), let line = String(data: d, encoding: .utf8) { print(line) }
  }
}

let checker = NSSpellChecker.shared
var memo: [String: Bool] = [:]
var languages = ["de", "en"]

func valid(_ w: String) -> Bool {
  if let v = memo[w] { return v }
  var variants = [w, w.lowercased(), w.prefix(1).uppercased() + w.dropFirst().lowercased()]
  if w == w.uppercased() { variants.append(w.prefix(1) + w.dropFirst().lowercased()) }
  var ok = false
  outer: for v in variants {
    for lang in languages {
      let r = checker.checkSpelling(of: v, startingAt: 0, language: lang, wrap: false, inSpellDocumentWithTag: 0, wordCount: nil)
      if r.location == NSNotFound { ok = true; break outer }
    }
  }
  memo[w] = ok
  return ok
}

// German compounds: "Eventkosten" = Event + kosten, "Geburtstagskuchen" = Geburtstag + s + kuchen (two levels deep).
func compound(_ w: String, depth: Int = 0) -> Bool {
  let chars = Array(w)
  // Parts of at least 4 letters: shorter splits ("kos" + "tel") make almost anything look valid.
  if chars.count < 8 || depth > 1 { return false }
  for i in 4...(chars.count - 4) {
    let left = String(chars[0..<i])
    let right = String(chars[i...])
    let rightOK = valid(right) || compound(right, depth: depth + 1)
    if !rightOK { continue }
    if valid(left) { return true }
    if left.hasSuffix("s") && left.count > 4 && valid(String(left.dropLast())) { return true }
  }
  return false
}

struct Verdict: Codable { let ok: Bool; let guess: String? }

// Edit distance with transpositions, case-insensitive: picks the closest guess across both languages.
func distance(_ a: String, _ b: String) -> Int {
  let x = Array(a.lowercased()), y = Array(b.lowercased())
  if x.isEmpty { return y.count }
  if y.isEmpty { return x.count }
  var d = [[Int]](repeating: [Int](repeating: 0, count: y.count + 1), count: x.count + 1)
  for i in 0...x.count { d[i][0] = i }
  for j in 0...y.count { d[0][j] = j }
  for i in 1...x.count {
    for j in 1...y.count {
      let cost = x[i - 1] == y[j - 1] ? 0 : 1
      d[i][j] = min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + cost)
      if i > 1 && j > 1 && x[i - 1] == y[j - 2] && x[i - 2] == y[j - 1] { d[i][j] = min(d[i][j], d[i - 2][j - 2] + 1) }
    }
  }
  return d[x.count][y.count]
}

struct SpellInput: Codable { let words: [String]; let text: String?; let languages: [String]? }
struct SpellOutput: Codable { let lang: String?; let verdicts: [String: Verdict] }
struct LangInput: Codable { let text: String }
struct LangOutput: Codable { let hypotheses: [String: Double] }

func spellMain() {
  let input = FileHandle.standardInput.readDataToEndOfFile()
  let req = (try? JSONDecoder().decode(SpellInput.self, from: input))
    ?? SpellInput(words: (try? JSONDecoder().decode([String].self, from: input)) ?? [], text: nil, languages: nil)
  let words = req.words
  // The languages the caller decided on (lib/text/language.ts), as the checker names them; never a guess of its own.
  if let asked = req.languages {
    let have = asked.compactMap { l in checker.availableLanguages.first(where: { $0 == l || $0.hasPrefix(l + "_") }) }
    var seen = Set<String>()
    let unique = have.filter { seen.insert($0).inserted }
    if !unique.isEmpty { languages = unique }
  }
  var detected: String? = nil
  if let text = req.text, !text.isEmpty {
    let rec = NLLanguageRecognizer()
    rec.processString(text)
    detected = rec.dominantLanguage?.rawValue
  }
  var out: [String: Verdict] = [:]
  for w in words {
    if valid(w) || compound(w) {
      out[w] = Verdict(ok: true, guess: nil)
      continue
    }
    let range = NSRange(location: 0, length: w.utf16.count)
    var guesses: [String] = []
    for lang in languages {
      guesses += (checker.guesses(forWordRange: range, in: w, language: lang, inSpellDocumentWithTag: 0) ?? []).prefix(4)
    }
    // Closest by edit distance; on a tie, keep the first letter (typos rarely hit it).
    let score = { (g: String) -> Int in distance(w, g) * 2 + (g.lowercased().first == w.lowercased().first ? 0 : 1) }
    let best = guesses.enumerated().min { a, b in
      let (sa, sb) = (score(a.element), score(b.element))
      return sa != sb ? sa < sb : a.offset < b.offset
    }?.element
    out[w] = Verdict(ok: false, guess: best)
  }
  if let d = try? JSONEncoder().encode(SpellOutput(lang: detected, verdicts: out)), let s = String(data: d, encoding: .utf8) { print(s) }
}

func langMain() {
  let input = FileHandle.standardInput.readDataToEndOfFile()
  let text = (try? JSONDecoder().decode(LangInput.self, from: input))?.text ?? ""
  let rec = NLLanguageRecognizer()
  rec.processString(text)
  var out: [String: Double] = [:]
  for (lang, p) in rec.languageHypotheses(withMaximum: 6) { out[lang.rawValue] = (p * 1000).rounded() / 1000 }
  if let d = try? JSONEncoder().encode(LangOutput(hypotheses: out)), let s = String(data: d, encoding: .utf8) { print(s) }
}

let args = CommandLine.arguments
switch args.count > 1 ? args[1] : "" {
case "ocr": ocrMain(Array(args.dropFirst(2)))
case "spell": spellMain()
case "lang": langMain()
default:
  FileHandle.standardError.write("usage: vr-ocr ocr <image>... | vr-ocr spell < words.json | vr-ocr lang < text.json\n".data(using: .utf8)!)
  exit(2)
}
