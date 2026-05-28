#include "voicechannelmemberaction.h"

#include <iterator>

#include <qtstreamdeck2/qstreamdeckpropertyinspectorbuilder.h>

#include "dvmplugin.h"
#include "dvmdevice.h"

VoiceChannelMemberAction::VoiceChannelMemberAction() {
	connect(this, &QStreamDeckAction::initialized, this, &VoiceChannelMemberAction::onInitialized);
}

void VoiceChannelMemberAction::onInitialized() {
	// Convert from string to int (legacy reasons)
	if(const auto v = setting("user_ix"); v.isDouble())
		setSetting("user_ix", QString::number(v.toInt()));
}

VoiceChannelMemberAction::VoiceChannelMemberResult VoiceChannelMemberAction::voiceChannelMember() {
	auto &lst = plugin()->voiceChannelMembers;

	// Clamp the per-device paging offset: members may have left while we were paged down.
	int &offset = device()->voiceChannelMemberIndexOffset;
	if(offset >= lst.size())
		offset = 0;

	const QString userID = setting("user_ix").toString();

	VoiceChannelMemberResult r;

	// A short value is an index into the (key-sorted) member list; a long value is an actual user ID.
	if(userID.length() < 4) {
		r.userIndex = userID.toInt() + offset;
		if(r.userIndex >= 0 && r.userIndex < lst.size()) {
			// Advance an iterator instead of allocating the whole key list via QMap::keys() on every update.
			auto it = std::next(lst.begin(), r.userIndex);
			r.mem = &it.value();
		}
		return r;
	}

	auto it = lst.find(userID);
	r.mem = it != lst.end() ? &*it : nullptr;
	return r;
}

void VoiceChannelMemberAction::buildPropertyInspector(QStreamDeckPropertyInspectorBuilder &b) {
	b.addLineEdit("user_ix", "User index or ID").linkWithActionSetting();
	b.addMessage(QStringList{
		"Index in the channel users list, indexed from 0.",
		"Alternatively, you can also use User ID (right click user -> copy ID) to set it to a specific user."
	});

	DVMAction::buildPropertyInspector(b);
}
