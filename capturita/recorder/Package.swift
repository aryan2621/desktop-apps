// swift-tools-version:6.0
import Foundation
import PackageDescription

// Embeds Info.plist into the binary so macOS shows the camera/microphone usage strings
// when the helper asks for permission.
let infoPlist = URL(fileURLWithPath: #filePath).deletingLastPathComponent().appendingPathComponent("Info.plist").path

let package = Package(
    name: "CapturitaRecorder",
    platforms: [.macOS(.v15)],
    targets: [
        .executableTarget(
            name: "capturita-recorder",
            path: "Sources/CapturitaRecorder",
            linkerSettings: [
                .unsafeFlags(["-Xlinker", "-sectcreate", "-Xlinker", "__TEXT", "-Xlinker", "__info_plist", "-Xlinker", infoPlist]),
            ]
        ),
    ],
    swiftLanguageModes: [.v5]
)
