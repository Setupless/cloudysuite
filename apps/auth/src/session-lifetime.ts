const DAY_SECONDS = 24 * 60 * 60;

// Long enough that someone who opens Mail now and then keeps getting push
// notifications, which need a live session. Each use pushes the end out again.
export const SESSION_LIFETIME_SECONDS = 60 * DAY_SECONDS;

// A session is renewed on use at most this often, so each session costs at most
// one D1 write a day.
export const SESSION_RENEWAL_SECONDS = DAY_SECONDS;
