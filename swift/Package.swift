// swift-tools-version: 5.9
import PackageDescription

let package = Package(
    name: "Glossa",
    platforms: [.macOS(.v14)],
    products: [
        .library(name: "GlossaCore", targets: ["GlossaCore"]),
        .executable(name: "Glossa", targets: ["Glossa"])
    ],
    targets: [
        .target(name: "GlossaCore", resources: [.process("Resources")], linkerSettings: [.linkedFramework("JavaScriptCore")]),
        .executableTarget(name: "Glossa", dependencies: ["GlossaCore"]),
        .testTarget(name: "GlossaCoreTests", dependencies: ["GlossaCore"])
    ]
)
