/*
 * Portable config.h for the vendored dtach 0.9 source.
 *
 * Upstream dtach generates this via autotools (./configure). We avoid that
 * dependency by hand-writing the feature macros for the two platforms Walnut
 * spawns terminals on: Linux (remote dev hosts) and macOS (local). Both
 * detect at compile time below — Linux has <pty.h>/forkpty in libutil, macOS
 * has <util.h>/forkpty in libutil. This lets `gcc *.c -lutil` build dtach
 * with no ./configure step, so provisioning on a fresh host is a single,
 * dependency-light compile.
 *
 * If a future host lacks these (extremely unlikely for any modern POSIX
 * system), the build fails loudly during provisioning and the terminal falls
 * back to the NO_DTACH install-hint card — never a silent state-losing shell.
 */
#ifndef DTACH_VENDOR_CONFIG_H
#define DTACH_VENDOR_CONFIG_H

/* master.c (signal handlers, via RETSIGTYPE) and main.c (PACKAGE_VERSION in
 * --version) reference these macros unconditionally. Autotools' ./configure
 * would define them; since we skip configure, this hand-written config.h MUST
 * define them too or the compile fails. */
#define PACKAGE_STRING "dtach 0.9"
#define PACKAGE_VERSION "0.9"
#define VERSION "0.9"
#define PACKAGE_BUGREPORT "crigler@users.sourceforge.net"
#define RETSIGTYPE void

/* Common POSIX features present on both Linux and macOS. */
#define HAVE_UNISTD_H 1
#define HAVE_SYS_IOCTL_H 1
#define HAVE_SYS_RESOURCE_H 1
#define HAVE_SYS_TIME_H 1
#define TIME_WITH_SYS_TIME 1
#define HAVE_FORKPTY 1

#if defined(__APPLE__)
/* macOS: forkpty + openpty live in <util.h>, linked via -lutil. */
#  define HAVE_UTIL_H 1
#  define HAVE_OPENPTY 1
#else
/* Linux / glibc: forkpty + openpty live in <pty.h>, linked via -lutil. */
#  define HAVE_PTY_H 1
#  define HAVE_OPENPTY 1
#endif

#endif /* DTACH_VENDOR_CONFIG_H */
