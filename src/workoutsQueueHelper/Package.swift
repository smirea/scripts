// swift-tools-version: 6.0
import PackageDescription

let package = Package(
    name: "WorkoutsQueue",
    platforms: [.macOS(.v15)],
    dependencies: [
        .package(url: "https://github.com/firebase/firebase-ios-sdk.git", exact: "12.12.0")
    ],
    targets: [
        .target(
            name: "QueueBridge",
            dependencies: [
                .product(name: "FirebaseFirestore", package: "firebase-ios-sdk")
            ],
            publicHeadersPath: "include"
        ),
        .executableTarget(
            name: "Queue",
            dependencies: [
                .product(name: "FirebaseCore", package: "firebase-ios-sdk"),
                .product(name: "FirebaseFirestore", package: "firebase-ios-sdk"),
                "QueueBridge"
            ]
        )
    ]
)
