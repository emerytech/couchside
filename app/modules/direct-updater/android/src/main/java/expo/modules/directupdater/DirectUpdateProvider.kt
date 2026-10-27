package expo.modules.directupdater

/** Separate provider so manifest merging cannot alter another module's authority. */
class DirectUpdateProvider : androidx.core.content.FileProvider()
