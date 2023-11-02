'use strict';

///////////////////////////
//ad tags
const adTagMainMenuBanner = "smashkarts-io_300x250";
const adTagWinCeremonyBanner = "smashkarts-io_300x250_2";
const adTagSpectateBanner = "smashkarts-io_300x250_3";
const adTagDeathBannerWeb = "smashkarts-io_728x90-new";
const adTagDeathBannerMobile = "smashkarts-io_320x100";

var currShownAdElementIds = [];

function hasAdContent(adElementId)
{
    const ad = document.getElementById(adElementId);

    return (ad != null && ad.innerHTML);
}

function showAd(adElementId)
{
    const ad = document.getElementById(adElementId);

    if(ad != null)
    {
        ad.style.display = "block";
    }
    
    currShownAdElementIds.push(adElementId);
}

function requestAd(adElementId, adShownTimestamp)
{
    if(currShownAdElementIds.includes(adElementId))
        return;
    
    if(Date.now() >= (adShownTimestamp.val + bannerMinRefreshDelayMillisecs) || !hasAdContent(adElementId))
    {
        adShownTimestamp.val = Date.now();

        destroyAd(adElementId);

        aiptag.cmd.display.push(function()
        {
            aipDisplayTag.display(adElementId);
            showAd(adElementId);
        });
    }
}

function hideAd(adElementId)
{
    if(currShownAdElementIds.includes(adElementId))
    {
        //for adinplay we dont distingush between hiding and destroying
        destroyAd(adElementId);
        
        //if we were hiding you would need to reset the currShownAdElement
        //currShownAdElementId = null;
    }
}

function destroyAd(adElementId)
{
    const ad = document.getElementById(adElementId);

    if(ad != null)
    {
        ad.style.display = "none";
        //ad.innerHTML = "";
        aiptag.cmd.display.push(function() 
        { 
            aipDisplayTag.destroy(adElementId); 
        });
    }
    
    const indexToRemove = currShownAdElementIds.indexOf(adElementId);
    
    if(indexToRemove >= 0)
    {
        currShownAdElementIds.splice(indexToRemove, 1);
    }
}

function requestMainMenuAd()
{
    requestAd(adTagMainMenuBanner, mainMenuBannerShownTimestamp);
}

function hideMainMenuAd()
{
    hideAd(adTagMainMenuBanner);
}

function requestWinCeremonyAd()
{
    requestAd(adTagWinCeremonyBanner, winCeremonyBannerShownTimestamp);
}

function hideWinCeremonyAd()
{
    hideAd(adTagWinCeremonyBanner);
}

function requestSpectateAd()
{
    requestAd(adTagSpectateBanner, spectateBannerShownTimestamp);
}

function hideSpectateAd()
{
    hideAd(adTagSpectateBanner);
}

function requestDeathAd()
{
    if(isMobile())
    {
        requestAd(adTagDeathBannerMobile, deathBannerShownTimestamp);
    }
    else
    {
        requestAd(adTagDeathBannerWeb, deathBannerShownTimestamp);
    }
}

function hideDeathAd()
{
    if(isMobile())
    {
        hideAd(adTagDeathBannerMobile);
    }
    else
    {
        hideAd(adTagDeathBannerWeb);
    }
}

function requestOffCanvasAd(adResArrayToHide, adTagIdToShow)
{
    hideOffCanvasAds(adResArrayToHide);

    aiptag.cmd.display.push(function()
    {
        aipDisplayTag.display(adTagIdToShow);
        showAd(adTagIdToShow);
    });
}

function hideOffCanvasAds(adResArray)
{
    adResArray.forEach(adRes => {
        destroyAd(adRes.adId);
    });
}
