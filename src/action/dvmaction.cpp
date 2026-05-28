#include "dvmaction.h"

#include <qtstreamdeck2/qstreamdeckpropertyinspectorbuilder.h>

#include "dvmplugin.h"

DVMAction::DVMAction() {
	connect(this, &QStreamDeckAction::initialized, this, &DVMAction::onInitialized);
	connect(this, &QStreamDeckAction::settingsChanged, this, &DVMAction::update);
}

void DVMAction::buildPropertyInspector(QStreamDeckPropertyInspectorBuilder &b) {
	b.addSection("Discord settings");
	b.addLineEdit("client_id", "Client ID").linkWithGlobalSetting();
	b.addLineEdit("client_secret", "Client secret").linkWithGlobalSetting();
	b.addMessage("For Discord, enter OAuth credentials. For Legcord, install the bundled bridge plugin and leave these fields empty. See the <a href=\"javascript: openUrl('https://github.com/dylanjkl/StreamDeck-DiscordVolumeMixer3');\">GitHub page</a>.");
}

void DVMAction::onInitialized() {
	connect(plugin(), &DVMPlugin::buttonsUpdateRequested, this, &DVMAction::update);
	connect(plugin(), &DVMPlugin::globalSettingsChanged, this, &DVMAction::update);

	QTimer::singleShot(0, this, &DVMAction::update);
}
