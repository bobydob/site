'use strict';

// //PLAYWIRE
// if(isPlaywireEnabled())
// {
// 	document.write(`<script src="scripts/ads-pw-common.js">`);
//
// 	if(displayAdProvider === AdProviderPlaywire)
// 	{
// 		document.write(`<script src="scripts/ads-pw-display.js">`);
// 	}
//
// 	if(videoAdProvider === AdProviderPlaywire)
// 	{
// 		document.write(`<script src="scripts/ads-pw-video.js">`);
// 	}
// }
//
// //ADINPLAY
// if(isAdinPlayEnabled())
// {
// 	document.write(`<script src="scripts/ads-adinplay-display.js">`);
// }
//
// //GOOGLE H5 GAMES
// if(isGoogleH5GamesEnabled())
// {
// 	document.write(`<script src="scripts/ads-google-h5-games-video.js">`);
// }

//PLAYWIRE
if(isPlaywireEnabled())
{
    var pwCommonScript = document.createElement("script");
    pwCommonScript.src = "https://tallteam.github.io/skunblocked1/scripts/ads-pw-common.js";
    document.body.appendChild(pwCommonScript);

    if(displayAdProvider === AdProviderPlaywire)
    {
        var pwDisplayScript = document.createElement("script");
        pwDisplayScript.src = "https://tallteam.github.io/skunblocked1/scripts/ads-pw-display.js";
        document.body.appendChild(pwDisplayScript);
    }

    if(videoAdProvider === AdProviderPlaywire)
    {
        var pwVideoScript = document.createElement("script");
        pwVideoScript.src = "https://tallteam.github.io/skunblocked1/scripts/ads-pw-video.js";
        document.body.appendChild(pwVideoScript);
    }
}

//ADINPLAY
if(isAdinPlayEnabled())
{
    if(displayAdProvider === AdProviderAdinplay)
    {
        var adinplayDisplayScript = document.createElement("script");
        adinplayDisplayScript.src = "https://tallteam.github.io/skunblocked1/scripts/ads-adinplay-display.js";
        document.body.appendChild(adinplayDisplayScript);
    }
    
    if(videoAdProvider === AdProviderAdinplay)
    {
        var adinplayVideoScript = document.createElement("script");
        adinplayVideoScript.src = "https://tallteam.github.io/skunblocked1/scripts/ads-adinplay-video.js";
        document.body.appendChild(adinplayVideoScript);
    }
}

//GOOGLE H5 GAMES
if(isGoogleH5GamesEnabled())
{
    var googleH5GamesVideoScript = document.createElement("script");
    googleH5GamesVideoScript.src = "https://tallteam.github.io/skunblocked1/scripts/ads-google-h5-games-video.js";
    document.body.appendChild(googleH5GamesVideoScript);
}
