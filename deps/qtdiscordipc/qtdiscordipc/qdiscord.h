#pragma once

#include <QObject>
#include <QLocalSocket>
#include <QJsonObject>
#include <QJsonArray>
#include <QTimer>
#include <QImage>
#include <QCache>
#include <QSet>
#include <QHash>
#include <QNetworkAccessManager>
#include <QUrl>
#include <QWebSocket>
#include <QWebSocketServer>

#include "qdiscordmessage.h"
#include "qdiscordreply.h"

class QDiscord : public QObject {
Q_OBJECT

public:
	static constexpr float minVoiceVolume = 0;
	static constexpr float maxVoiceVolume = 200;

public:
	enum class CommandType {
		unknown = -1,
		dispatch,
		authorize,
		authenticate,

		getGuild,
		getGuilds,
		getChannel,
		getChannels,

		subscribe,
		unsubscribe,

		setUserVoiceSettings,
		selectVoiceChannel,
		getSelectedVoiceChannel,
		selectTextChannel,
		setVoiceSettings,
		getVoiceSettings,
		setCertifiedDevices,

		setActivity,
		sendActivityJoinInvite,
		closeActivityRequest,
	};

	Q_ENUM(CommandType);

public:
	QDiscord();
	~QDiscord();

public:
	/// Maps volume value returned by the IPC to the value that is shown in the Discord UI
	static double ipcToUIVolume(double v);

	/// Maps volume value that is shown in the Discord UI to the value range the IPC uses
	static double uiToIPCVolume(double v);

public:
	/**
	 * Tries to connext to the Discord. Returns true if successfull (this function is blocking)
	 */
	bool connect(const QString &clientID, const QString &clientSecret);

	void disconnect();

	inline bool isConnected() const {
		return isConnected_;
	}

	/// Returns a short, human-readable label for the current connection error, suitable for a Stream Deck key.
	/// Internally errors are stored as compact codes ("ERR 0"...) which are kept verbatim in the logs.
	QString connectionError() const {
		static const QHash<QString, QString> readable{
			{QStringLiteral("ERR 0"), QStringLiteral("No login")},
			{QStringLiteral("ERR 1"), QStringLiteral("No Discord")},
			{QStringLiteral("ERR 2"), QStringLiteral("Discord err")},
			{QStringLiteral("ERR 3"), QStringLiteral("Net error")},
			{QStringLiteral("ERR 4"), QStringLiteral("Auth denied")},
			{QStringLiteral("ERR 5"), QStringLiteral("Net error")},
			{QStringLiteral("ERR 6"), QStringLiteral("Auth failed")},
			{QStringLiteral("ERR 7"), QStringLiteral("Auth failed")},
			{QStringLiteral("ERR 8"), QStringLiteral("No Discord")},
			{QStringLiteral("ERR L"), QStringLiteral("No Legcord")},
			{QStringLiteral("DISCONNECTED"), QStringLiteral("Offline")},
		};
		const auto it = readable.constFind(connectionError_);
		return it != readable.constEnd() ? it.value() : connectionError_;
	}

	inline const QString &userID() const {
		return userID_;
	}

	/// Returns whether the discord is processing something (connecting, waiting for message, ...)
	inline bool isProcessing() const {
		return processing_ > 0;
	}

public:
	/**
	 * Sends a command. Asynchronously returns the result via QDiscordReply::finished
	 * $args is put in the "args" field.
	 * $msgOverrides is injected into the main body
	 */
	QDiscordReply *sendCommand(const QString &command, const QJsonObject &args = {}, const QJsonObject &msgOverrides = {});

public:
	/// The function can be async, the avatar loading can be delayed and then signalled using avatarReady
	QImage getUserAvatar(const QString &userId, const QString &avatarId);

signals:
	/// This signal is emitted when there is a message received that is not a response to a command
	void messageReceived(const QDiscordMessage &msg);

	void avatarReady(const QString &avatarId, const QImage &img);

	void connected();

	void disconnected();

private:
	/// Blockingly reads a single message.
	QDiscordMessage readMessage();

	void sendMessage(const QJsonObject &packet, int opCode = 1);

	/**
 * Processes incoming messages.
 */
	void processMessage(const QDiscordMessage &msg);

private:
	/// Blocking waits until given amount of bytes is available
	QByteArray blockingReadBytes(int bytes);

	/// Non-blocking processes received messsages
	void readAndProcessMessages();

private:
	enum class Backend {
		DiscordIpc,
		LegcordBridge,
	};

	bool connectDiscordIpc(const QString &clientID, const QString &clientSecret);
	bool connectLegcordBridge();

	QJsonObject requestLegcordBridge(const QString &method, const QString &path, const QJsonObject &payload = {}, int timeoutMs = 1000);
	void sendLegcordBridgeMessage(const QJsonObject &packet);
	void pollLegcordBridgeEvents();

	bool connectLegcordSocketBridge();
	bool startLegcordSocketBridge();
	void stopLegcordSocketBridge();
	void processLegcordSocketMessage(const QString &message);
	void sendLegcordSocketMessage(const QJsonObject &packet);

private:
	QLocalSocket socket_;
	bool isConnected_ = false;
	QString connectionError_;
	QString userID_;
	QString cdn_;
	int nonceCounter_ = 0;
	int blockingRead_ = 0;
	int processing_ = 0;
	Backend backend_ = Backend::DiscordIpc;

private:
	QNetworkAccessManager netMgr_;
	QCache<QString, QImage> avatarsCache_;
	QSet<QString> avatarsRequested_; ///< Avatar IDs with a network request currently in flight (dedup).
	QHash<QString, QDiscordReply *> pendingReplies_;

	QUrl legcordBridgeUrl_{QStringLiteral("http://127.0.0.1:6888")};
	QTimer legcordPollTimer_;
	int legcordLastEventId_ = 0;
	bool legcordPollInProgress_ = false;

	QWebSocketServer legcordSocketServer_;
	QWebSocket *legcordSocket_ = nullptr;
	QString legcordSocketUserID_;

};

QString operator +(QDiscord::CommandType ct);
