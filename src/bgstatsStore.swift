import AppKit
import CoreData
import Foundation

private let bundleIdentifier = "nl.vissering.BoardGameStats"

struct PlayInput: Decodable {
    struct GameInput: Decodable {
        let uuid: String?
        let name: String
        let bggId: Int?
        let highestWins: Bool?
        let highestScoreWins: Bool?
        let noPoints: Bool?
    }

    struct LocationInput: Decodable {
        let name: String
    }

    struct PlayerInput: Decodable {
        let uuid: String?
        let name: String
        let sourcePlayerId: String?
        let startPlayer: Bool?
        let winner: Bool?
        let score: Score?
        let rank: Int?
        let role: String?
        let team: String?
    }

    enum Score: Decodable {
        case number(Double)
        case string(String)

        init(from decoder: Decoder) throws {
            let container = try decoder.singleValueContainer()
            if let number = try? container.decode(Double.self) {
                self = .number(number)
            } else {
                self = .string(try container.decode(String.self))
            }
        }

        var stringValue: String {
            switch self {
            case let .number(value):
                return value.rounded() == value ? String(Int(value)) : String(value)
            case let .string(value):
                return value
            }
        }
    }

    let uuid: String?
    let sourceName: String
    let sourcePlayId: String
    let playDate: String?
    let durationMin: Int?
    let comments: String?
    let board: String?
    let location: LocationInput?
    let game: GameInput
    let players: [PlayerInput]
}

struct RecordResult: Encodable {
    let playUuid: String
    let alreadyExists: Bool
    let createdPlayers: [String]
}

struct SyncResult: Encodable {
    let playUuid: String
    let action: String
    let createdPlayers: [String]
}

func fail(_ message: String) -> Never {
    FileHandle.standardError.write(Data("\(message)\n".utf8))
    exit(1)
}

func quitApp() {
    let applications = NSRunningApplication.runningApplications(withBundleIdentifier: bundleIdentifier)
    for application in applications where !application.isTerminated {
        _ = application.terminate()
    }

    let deadline = Date().addingTimeInterval(15)
    while applications.contains(where: { !$0.isTerminated }) && Date() < deadline {
        RunLoop.current.run(until: Date().addingTimeInterval(0.1))
    }
    if applications.contains(where: { !$0.isTerminated }) {
        fail("BG Stats did not quit within 15 seconds.")
    }
}

func activateApp() {
    guard let application = NSRunningApplication.runningApplications(withBundleIdentifier: bundleIdentifier)
        .first(where: { !$0.isTerminated }) else {
        fail("BG Stats is not running.")
    }
    if !application.activate(options: [.activateAllWindows]) {
        fail("BG Stats could not be activated.")
    }
}

func loadContext(databasePath: String, modelPath: String) throws -> NSManagedObjectContext {
    guard let loadedModel = NSManagedObjectModel(contentsOf: URL(fileURLWithPath: modelPath)),
          let model = loadedModel.copy() as? NSManagedObjectModel else {
        throw NSError(domain: "bgstats", code: 1, userInfo: [NSLocalizedDescriptionKey: "Could not load the BG Stats Core Data model."])
    }
    for entity in model.entities {
        entity.managedObjectClassName = "NSManagedObject"
    }

    let coordinator = NSPersistentStoreCoordinator(managedObjectModel: model)
    try coordinator.addPersistentStore(
        ofType: NSSQLiteStoreType,
        configurationName: nil,
        at: URL(fileURLWithPath: databasePath),
        options: [
            NSMigratePersistentStoresAutomaticallyOption: false,
            NSInferMappingModelAutomaticallyOption: false,
        ]
    )
    let context = NSManagedObjectContext(concurrencyType: .privateQueueConcurrencyType)
    context.persistentStoreCoordinator = coordinator
    context.mergePolicy = NSMergeByPropertyObjectTrumpMergePolicy
    return context
}

func fetchOne(
    _ entityName: String,
    in context: NSManagedObjectContext,
    predicate: NSPredicate
) throws -> NSManagedObject? {
    let request = NSFetchRequest<NSManagedObject>(entityName: entityName)
    request.predicate = predicate
    request.fetchLimit = 2
    let results = try context.fetch(request)
    if results.count > 1 {
        throw NSError(domain: "bgstats", code: 2, userInfo: [NSLocalizedDescriptionKey: "More than one \(entityName) matched the supplied identity."])
    }
    return results.first
}

func insert(_ entityName: String, into context: NSManagedObjectContext) -> NSManagedObject {
    NSEntityDescription.insertNewObject(forEntityName: entityName, into: context)
}

func uppercasedUuid() -> String {
    UUID().uuidString.uppercased()
}

func setSyncIdentity(_ object: NSManagedObject, uuid: String, now: Date) {
    object.setValue(uuid, forKey: "uuid")
    object.setValue(now, forKey: "modificationDateTime")
    object.setValue(nil, forKey: "lastCloudSync")
}

func findOrCreateGame(
    _ input: PlayInput.GameInput,
    context: NSManagedObjectContext,
    now: Date
) throws -> NSManagedObject {
    let existing: NSManagedObject?
    if let uuid = input.uuid {
        existing = try fetchOne("Game", in: context, predicate: NSPredicate(format: "uuid == %@", uuid))
    } else if let bggId = input.bggId, bggId > 0 {
        existing = try fetchOne("Game", in: context, predicate: NSPredicate(format: "bggId == %d", bggId))
    } else {
        existing = try fetchOne("Game", in: context, predicate: NSPredicate(format: "name ==[cd] %@", input.name))
    }
    if let existing {
        return existing
    }

    let game = insert("Game", into: context)
    setSyncIdentity(game, uuid: input.uuid ?? uppercasedUuid(), now: now)
    game.setValue(input.name, forKey: "name")
    game.setValue(input.bggId ?? 0, forKey: "bggId")
    game.setValue(input.highestWins ?? input.highestScoreWins, forKey: "highestScoreWins")
    game.setValue(input.noPoints, forKey: "noPoints")
    game.setValue("{}", forKey: "metaData")
    return game
}

func normalizedLocationName(_ name: String) -> String {
    let suffix = name.split(separator: ":").last.map(String.init) ?? name
    return suffix.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
}

func findOrCreateLocation(
    name: String,
    context: NSManagedObjectContext,
    now: Date
) throws -> NSManagedObject {
    let request = NSFetchRequest<NSManagedObject>(entityName: "Location")
    let locations = try context.fetch(request)
    let normalizedInput = normalizedLocationName(name)
    let matches = locations.filter {
        guard let storedName = $0.value(forKey: "name") as? String else { return false }
        return normalizedLocationName(storedName) == normalizedInput
    }
    if matches.count > 1 {
        throw NSError(domain: "bgstats", code: 3, userInfo: [NSLocalizedDescriptionKey: "More than one BG Stats location matches \(name)."])
    }
    if let match = matches.first {
        return match
    }

    let location = insert("Location", into: context)
    setSyncIdentity(location, uuid: uppercasedUuid(), now: now)
    location.setValue(name, forKey: "name")
    location.setValue("{}", forKey: "metaData")
    return location
}

func findOrCreatePlayer(
    _ input: PlayInput.PlayerInput,
    sourceName: String,
    context: NSManagedObjectContext,
    now: Date
) throws -> (NSManagedObject, Bool) {
    if let uuid = input.uuid {
        guard let existing = try fetchOne("Player", in: context, predicate: NSPredicate(format: "uuid == %@", uuid)) else {
            throw NSError(domain: "bgstats", code: 4, userInfo: [NSLocalizedDescriptionKey: "Could not find mapped BG Stats player \(input.name) (\(uuid))."])
        }
        return (existing, false)
    }
    if let sourcePlayerId = input.sourcePlayerId {
        let request = NSFetchRequest<NSManagedObject>(entityName: "Player")
        request.predicate = NSPredicate(format: "metaData CONTAINS %@", sourcePlayerId)
        let matches = try context.fetch(request).filter { player in
            guard let metadata = player.value(forKey: "metaData") as? String,
                  let data = metadata.data(using: .utf8),
                  let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
                  let source = json["bgstatsCli"] as? [String: String] else {
                return false
            }
            return source["sourceName"] == sourceName && source["sourcePlayerId"] == sourcePlayerId
        }
        if matches.count > 1 {
            throw NSError(domain: "bgstats", code: 5, userInfo: [NSLocalizedDescriptionKey: "More than one BG Stats player maps to \(sourcePlayerId)."])
        }
        if let existing = matches.first {
            return (existing, false)
        }
    } else if let existing = try fetchOne(
        "Player",
        in: context,
        predicate: NSPredicate(format: "name ==[cd] %@", input.name)
    ) {
        return (existing, false)
    }

    let player = insert("Player", into: context)
    setSyncIdentity(player, uuid: uppercasedUuid(), now: now)
    player.setValue(input.name, forKey: "name")
    player.setValue(0, forKey: "isAnonymous")
    player.setValue(0, forKey: "isMe")
    let metadata: [String: Any]
    if let sourcePlayerId = input.sourcePlayerId {
        metadata = [
            "bgstatsCli": [
                "sourceName": sourceName,
                "sourcePlayerId": sourcePlayerId,
            ],
        ]
    } else {
        metadata = [:]
    }
    let metadataData = try JSONSerialization.data(withJSONObject: metadata, options: [.sortedKeys])
    player.setValue(String(decoding: metadataData, as: UTF8.self), forKey: "metaData")
    return (player, true)
}

func parseDate(_ value: String?) throws -> Date {
    guard let value else { return Date() }
    let localFormatter = DateFormatter()
    localFormatter.calendar = Calendar(identifier: .gregorian)
    localFormatter.locale = Locale(identifier: "en_US_POSIX")
    localFormatter.timeZone = .current
    for format in ["yyyy-MM-dd HH:mm:ss", "yyyy-MM-dd"] {
        localFormatter.dateFormat = format
        if let date = localFormatter.date(from: value) {
            return date
        }
    }

    let isoFormatter = ISO8601DateFormatter()
    isoFormatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    if let date = isoFormatter.date(from: value) {
        return date
    }
    isoFormatter.formatOptions = [.withInternetDateTime]
    if let date = isoFormatter.date(from: value) {
        return date
    }
    throw NSError(domain: "bgstats", code: 4, userInfo: [NSLocalizedDescriptionKey: "Invalid playDate: \(value)"])
}

func existingPlay(
    sourceName: String,
    sourcePlayId: String,
    uuid: String?,
    context: NSManagedObjectContext
) throws -> NSManagedObject? {
    if let uuid,
       let play = try fetchOne("Play", in: context, predicate: NSPredicate(format: "uuid == %@", uuid)) {
        return play
    }
    let request = NSFetchRequest<NSManagedObject>(entityName: "Play")
    request.predicate = NSPredicate(format: "metaData CONTAINS %@", sourcePlayId)
    for play in try context.fetch(request) {
        guard let metadata = play.value(forKey: "metaData") as? String,
              let data = metadata.data(using: .utf8),
              let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let source = json["bgstatsCli"] as? [String: String],
              source["sourceName"] == sourceName,
              source["sourcePlayId"] == sourcePlayId else {
            continue
        }
        return play
    }
    return nil
}

func applyPlayInput(
    _ input: PlayInput,
    to play: NSManagedObject,
    context: NSManagedObjectContext,
    now: Date,
    preserveLocationAndDuration: Bool
) throws -> [String] {
    let playDate = try parseDate(input.playDate)
    let calendar = Calendar.current
    let dateParts = calendar.dateComponents([.year, .month, .day, .weekday], from: playDate)
    guard let year = dateParts.year, let month = dateParts.month, let day = dateParts.day,
          let weekday = dateParts.weekday else {
        throw NSError(domain: "bgstats", code: 6, userInfo: [NSLocalizedDescriptionKey: "Could not derive BG Stats date fields."])
    }

    let game = try findOrCreateGame(input.game, context: context, now: now)
    play.setValue(now, forKey: "modificationDateTime")
    play.setValue(nil, forKey: "lastCloudSync")
    play.setValue(playDate, forKey: "playDateTime")
    play.setValue(year * 10_000 + month * 100 + day, forKey: "playDateYmd")
    play.setValue(month, forKey: "playMonth")
    play.setValue(weekday, forKey: "playWeekday")
    if !preserveLocationAndDuration {
        let location = try input.location.map {
            try findOrCreateLocation(name: $0.name, context: context, now: now)
        }
        play.setValue(input.durationMin ?? 0, forKey: "duration")
        play.setValue(location, forKey: "playLocation")
    }
    play.setValue(input.comments, forKey: "comments")
    play.setValue(input.board, forKey: "board")
    play.setValue(input.players.count, forKey: "playerCount")
    play.setValue(input.players.contains(where: { $0.winner == true }) ? 1 : 0, forKey: "manualWinner")
    if input.game.noPoints == true {
        play.setValue(3, forKey: "scoringSetting")
    }
    play.setValue(game, forKey: "playedGame")
    let metadata: [String: Any] = [
        "bgstatsCli": [
            "sourceName": input.sourceName,
            "sourcePlayId": input.sourcePlayId,
        ],
    ]
    let metadataData = try JSONSerialization.data(withJSONObject: metadata, options: [.sortedKeys])
    play.setValue(String(decoding: metadataData, as: UTF8.self), forKey: "metaData")

    let existingScores = play.mutableSetValue(forKey: "scores").allObjects.compactMap { $0 as? NSManagedObject }
    for score in existingScores {
        context.delete(score)
    }

    var createdPlayers: [String] = []
    for (index, playerInput) in input.players.enumerated() {
        let (player, isNewPlayer) = try findOrCreatePlayer(
            playerInput,
            sourceName: input.sourceName,
            context: context,
            now: now
        )
        if isNewPlayer {
            createdPlayers.append(playerInput.name)
        }
        let score = insert("PlayerScore", into: context)
        score.setValue(play, forKey: "play")
        score.setValue(player, forKey: "player")
        score.setValue(playerInput.startPlayer ?? false, forKey: "isStartPlayer")
        score.setValue(isNewPlayer, forKey: "isNewPlayer")
        score.setValue(playerInput.winner ?? false, forKey: "win")
        score.setValue(playerInput.score?.stringValue, forKey: "score")
        score.setValue(playerInput.rank ?? 0, forKey: "rank")
        score.setValue(playerInput.role, forKey: "role")
        score.setValue(playerInput.team, forKey: "team")
        score.setValue(index + 1, forKey: "seatOrder")
        score.setValue("{}", forKey: "metaData")
    }

    return createdPlayers
}

func createPlay(
    _ input: PlayInput,
    context: NSManagedObjectContext,
    now: Date
) throws -> (String, [String]) {
    let play = insert("Play", into: context)
    let playUuid = input.uuid ?? uppercasedUuid()
    setSyncIdentity(play, uuid: playUuid, now: now)
    play.setValue(now, forKey: "entryDateTime")
    let createdPlayers = try applyPlayInput(
        input,
        to: play,
        context: context,
        now: now,
        preserveLocationAndDuration: false
    )
    return (playUuid, createdPlayers)
}

func recordPlay(_ input: PlayInput, context: NSManagedObjectContext) throws -> RecordResult {
    if let existing = try existingPlay(
        sourceName: input.sourceName,
        sourcePlayId: input.sourcePlayId,
        uuid: input.uuid,
        context: context
    ) {
        guard let uuid = existing.value(forKey: "uuid") as? String else {
            throw NSError(domain: "bgstats", code: 5, userInfo: [NSLocalizedDescriptionKey: "The matching play has no UUID."])
        }
        return RecordResult(playUuid: uuid, alreadyExists: true, createdPlayers: [])
    }

    let (playUuid, createdPlayers) = try createPlay(input, context: context, now: Date())
    try context.save()
    return RecordResult(playUuid: playUuid, alreadyExists: false, createdPlayers: createdPlayers)
}

func syncPlay(_ input: PlayInput, context: NSManagedObjectContext) throws -> SyncResult {
    let existing = try existingPlay(
        sourceName: input.sourceName,
        sourcePlayId: input.sourcePlayId,
        uuid: input.uuid,
        context: context
    )
    let now = Date()
    if let existing {
        guard let uuid = existing.value(forKey: "uuid") as? String else {
            throw NSError(domain: "bgstats", code: 7, userInfo: [NSLocalizedDescriptionKey: "The matching play has no UUID."])
        }
        let createdPlayers = try applyPlayInput(
            input,
            to: existing,
            context: context,
            now: now,
            preserveLocationAndDuration: true
        )
        return SyncResult(playUuid: uuid, action: "updated", createdPlayers: createdPlayers)
    }
    if let uuid = input.uuid {
        throw NSError(
            domain: "bgstats",
            code: 8,
            userInfo: [NSLocalizedDescriptionKey: "Could not find mapped BG Stats play \(uuid)."]
        )
    }
    let (uuid, createdPlayers) = try createPlay(input, context: context, now: now)
    return SyncResult(playUuid: uuid, action: "created", createdPlayers: createdPlayers)
}

let arguments = CommandLine.arguments
guard arguments.count >= 2 else {
    fail("Expected activate-app, quit-app, record, or sync.")
}

switch arguments[1] {
case "activate-app":
    activateApp()
case "quit-app":
    quitApp()
case "record":
    guard arguments.count == 4 else {
        fail("record requires a database path and model path.")
    }
    do {
        let input = try JSONDecoder().decode(PlayInput.self, from: FileHandle.standardInput.readDataToEndOfFile())
        let context = try loadContext(databasePath: arguments[2], modelPath: arguments[3])
        let result = try context.performAndWait {
            try recordPlay(input, context: context)
        }
        let data = try JSONEncoder().encode(result)
        FileHandle.standardOutput.write(data)
        FileHandle.standardOutput.write(Data("\n".utf8))
    } catch {
        fail(error.localizedDescription)
    }
case "sync":
    guard arguments.count == 4 else {
        fail("sync requires a database path and model path.")
    }
    do {
        let inputs = try JSONDecoder().decode([PlayInput].self, from: FileHandle.standardInput.readDataToEndOfFile())
        let context = try loadContext(databasePath: arguments[2], modelPath: arguments[3])
        let results = try context.performAndWait {
            let values = try inputs.map { try syncPlay($0, context: context) }
            try context.save()
            return values
        }
        let data = try JSONEncoder().encode(results)
        FileHandle.standardOutput.write(data)
        FileHandle.standardOutput.write(Data("\n".utf8))
    } catch {
        fail(error.localizedDescription)
    }
default:
    fail("Unknown command: \(arguments[1])")
}
