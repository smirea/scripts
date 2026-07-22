import Foundation
import FirebaseCore
import FirebaseFirestore
import QueueBridge

@main
struct Queue {
    static func main() async throws {
        guard CommandLine.arguments.count == 3 else {
            throw NSError(domain: "Queue", code: 1, userInfo: [NSLocalizedDescriptionKey: "Expected user ID and operations JSON path."])
        }

        WorkoutsQueueRegisterAuth(CommandLine.arguments[1])
        let options = FirebaseOptions(
            googleAppID: "1:122915645538:ios:9464913cdf3c2d57b8c93b",
            gcmSenderID: "122915645538"
        )
        options.apiKey = "offline-queue"
        options.bundleID = "com.sbs.train"
        options.projectID = "sbs-diet-app"
        FirebaseApp.configure(options: options)

        let data = try Data(contentsOf: URL(fileURLWithPath: CommandLine.arguments[2]))
        guard
            let input = try JSONSerialization.jsonObject(with: data) as? [String: Any],
            let writes = input["writes"] as? [[String: Any]],
            let firstPath = writes.first?["path"] as? String
        else {
            throw NSError(domain: "Queue", code: 2, userInfo: [NSLocalizedDescriptionKey: "Operations JSON must include writes."])
        }

        let firestore = Firestore.firestore()
        try await firestore.disableNetwork()
        let firstDocument = firestore.document(firstPath)

        try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
            var registration: ListenerRegistration?
            registration = firstDocument.addSnapshotListener(includeMetadataChanges: true) { snapshot, error in
                if let error {
                    registration?.remove()
                    continuation.resume(throwing: error)
                } else if snapshot?.metadata.hasPendingWrites == true {
                    registration?.remove()
                    continuation.resume()
                }
            }

            let batch = firestore.batch()
            for write in writes {
                guard
                    let path = write["path"] as? String,
                    let fields = write["data"] as? [String: Any]
                else {
                    continue
                }
                batch.setData(
                    fields,
                    forDocument: firestore.document(path),
                    merge: write["merge"] as? Bool ?? false
                )
            }
            batch.commit { _ in }
        }
        try await firestore.terminate()
    }
}
