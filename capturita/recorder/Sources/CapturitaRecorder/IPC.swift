import Foundation

/// Line-delimited JSON over stdin/stdout.
/// Requests:  {"id": 1, "cmd": "listSources", "args": {...}}
/// Replies:   {"id": 1, "ok": true, "result": ...} or {"id": 1, "ok": false, "error": "..."}
/// Events:    {"event": "cameraClosed", "data": {...}}
enum IPC {
    private static let lock = NSLock()

    static func reply(_ id: Int, result: Any = NSNull()) {
        write(["id": id, "ok": true, "result": result])
    }

    static func fail(_ id: Int, _ message: String) {
        write(["id": id, "ok": false, "error": message])
    }

    static func event(_ name: String, _ data: Any = NSNull()) {
        write(["event": name, "data": data])
    }

    static func log(_ message: String) {
        FileHandle.standardError.write(Data("[recorder] \(message)\n".utf8))
    }

    private static func write(_ object: [String: Any]) {
        guard var data = try? JSONSerialization.data(withJSONObject: object) else {
            log("could not encode message: \(object)")
            return
        }
        data.append(0x0A)
        lock.lock()
        FileHandle.standardOutput.write(data)
        lock.unlock()
    }
}

struct RecorderError: LocalizedError {
    let message: String
    init(_ message: String) { self.message = message }
    var errorDescription: String? { message }
}

extension Dictionary where Key == String, Value == Any {
    func string(_ key: String) -> String? { self[key] as? String }
    func bool(_ key: String) -> Bool? { self[key] as? Bool }
    func number(_ key: String) -> Double? { (self[key] as? NSNumber)?.doubleValue }
    func dict(_ key: String) -> [String: Any]? { self[key] as? [String: Any] }
}

func rectJSON(_ rect: CGRect) -> [String: Any] {
    ["x": rect.origin.x, "y": rect.origin.y, "width": rect.width, "height": rect.height]
}

func rect(from json: [String: Any]?) -> CGRect? {
    guard let json, let x = json.number("x"), let y = json.number("y"), let w = json.number("width"), let h = json.number("height") else {
        return nil
    }
    return CGRect(x: x, y: y, width: w, height: h)
}
