// Visitor stats with PostHog, feeding the private stats dashboard.
// Cookieless: no cookies or browser storage, nothing that identifies anyone.
// The project token below is meant to be public (it can only send stats in).
(function () {
  var POSTHOG_TOKEN = 'phc_CWLJPgoGRSCXsnc2ECFVdktXZ7AJzznW7rvbLtkVeMTn'; // PostHog project token (public)
  var POSTHOG_HOST = 'https://eu.i.posthog.com';  // EU cloud

  if (!POSTHOG_TOKEN) return;

  // PostHog's standard loader snippet.
  !function(t,e){var o,n,p,r;e.__SV||(window.posthog&&window.posthog.__loaded)||(window.posthog=e,e._i=[],e.init=function(i,s,a){function g(t,e){var o=e.split(".");2==o.length&&(t=t[o[0]],e=o[1]),t[e]=function(){t.push([e].concat(Array.prototype.slice.call(arguments,0)))}}(p=t.createElement("script")).type="text/javascript",p.crossOrigin="anonymous",p.async=!0,p.src=s.api_host.replace(".i.posthog.com","-assets.i.posthog.com")+"/static/array.js",(r=t.getElementsByTagName("script")[0]).parentNode.insertBefore(p,r);var u=e;for(void 0!==a?u=e[a]=[]:a="posthog",u.people=u.people||[],u.toString=function(t){var e="posthog";return"posthog"!==a&&(e+="."+a),t||(e+=" (stub)"),e},u.people.toString=function(){return u.toString(1)+".people (stub)"},o="init capture register register_once register_for_session unregister unregister_for_session getFeatureFlag getFeatureFlagPayload isFeatureEnabled reloadFeatureFlags on onFeatureFlags onSessionId identify setPersonProperties group resetGroups reset get_distinct_id getGroups get_session_id alias set_config captureException get_property getSessionProperty opt_in_capturing opt_out_capturing has_opted_in_capturing has_opted_out_capturing clear_opt_in_out_capturing debug".split(" "),n=0;n<o.length;n++)g(u,o[n]);e._i.push([i,s,a])},e.__SV=1)}(document,window.posthog||[]);

  window.posthog.init(POSTHOG_TOKEN, {
    api_host: POSTHOG_HOST,
    defaults: '2026-08-30',
    cookieless_mode: 'always',        // no cookies (turn on cookieless tracking in PostHog too)
    person_profiles: 'identified_only',
    disable_session_recording: true,
    disable_surveys: true
  });
})();

// Lets other scripts record an action, e.g. siteStat('race_opened', { race_name: '...' }).
// Does nothing if stats are off or blocked.
window.siteStat = function (name, props) {
  try { if (window.posthog && window.posthog.capture) window.posthog.capture(name, props || {}); } catch (e) { /* ignore */ }
};
