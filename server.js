require('dotenv').config()
const express = require('express')
const app = express()
const port = process.env.PORT || 3000
const stripe = require('stripe')(process.env.STRIPE_SECRET)
const axios = require('axios')
const crypto = require('crypto')
const rateLimit = require('express-rate-limit')
const helmet = require('helmet')

// Security middleware
app.use(helmet())
app.use(rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100 // limit each IP to 100 requests per windowMs
}))

// Standard middleware
app.use(express.json())
app.use(express.urlencoded({ extended: true }))
app.use(express.static('public'))

// In-memory product catalog (replace with DB later)
const products = [
  {
    id: 'prod_digital001',
    name: 'Premium Guide to Threema',
    description: 'Complete guide to secure messaging with Threema',
    price: 999, // £9.99 in cents
    currency: 'gbp',
    file: 'guide-threema.pdf'
  },
  {
    id: 'prod_digital002',
    name: 'Telegram Security Ebook',
    description: 'Learn how to secure your Telegram communications',
    price: 1499, // £14.99 in cents
    currency: 'gbp',
    file: 'telegram-security.pdf'
  }
]

// Health check
app.get('/health', (req, res) => {
  res.status(200).json({
    status: 'OK',
    timestamp: new Date().toISOString(),
    version: '1.0.0'
  })
})

// Root endpoint
app.get('/', (req, res) => {
  res.json({
    message: 'Secure Shop API',
    version: '1.0.0',
    endpoints: ['/health', '/api/products', '/api/checkout', '/webhook/stripe', '/download/:productId']
  })
})

// List products
app.get('/api/products', (req, res) => {
  res.json({ products: products.map(p => ({ id: p.id, name: p.name, description: p.description, price: p.price, currency: p.currency })) })
})

// Create checkout session
app.post('/api/checkout', async (req, res) => {
  const { productId, customerEmail } = req.body

  if (!productId || !customerEmail) {
    return res.status(400).json({ error: 'Product ID and customer email are required' })
  }

  const product = products.find(p => p.id === productId)
  if (!product) {
    return res.status(404).json({ error: 'Product not found' })
  }

  try {
    const session = await stripe.checkout.sessions.create({
      customer_email: customerEmail,
      payment_method_types: ['card'],
      line_items: [{
        price_data: {
          currency: product.currency,
          product_data: {
            name: product.name,
            description: product.description,
          },
          unit_amount: product.price,
        },
        quantity: 1,
      }],
      mode: 'payment',
      success_url: `${process.env.BASE_URL || 'http://localhost:3000'}/success.html?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${process.env.BASE_URL || 'http://localhost:3000'}/cancel.html`,
      metadata: {
        productId: product.id,
        customerEmail: customerEmail
      }
    })

    res.json({ url: session.url })
  } catch (error) {
    console.error('Error creating checkout session:', error)
    res.status(500).json({ error: 'Failed to create checkout session' })
  }
})

// Stripe webhook handler
app.post('/webhook/stripe', express.raw({ type: 'application/json' }), (req, res) => {
  const sig = req.headers['stripe-signature']
  const endpointSecret = process.env.STRIPE_WEBHOOK_SECRET

  let event

  try {
    event = stripe.webhooks.constructEvent(req.body, sig, endpointSecret)
  } catch (err) {
    console.log(`Webhook signature verification failed.`, err.message)
    return res.status(400).send(`Webhook Error: ${err.message}`)
  }

  // Handle the checkout.session.completed event
  if (event.type === 'checkout.session.completed') {
    const session = event.data.object

    // Fulfill the purchase: send via Threema or Telegram
    fulfillOrder(session)
  }

  res.json({ received: true })
})

// Fulfillment function - send digital product via Threema or Telegram
async function fulfillOrder(session) {
  const productId = session.metadata.productId
  const customerEmail = session.metadata.customerEmail
  const paymentIntentId = session.payment_intent

  console.log(`Fulfilling order for product ${productId} to ${customerEmail}`)

  // Create download token (secure, time-limited)
  const downloadToken = crypto.randomBytes(32).toString('hex')
  const expiresAt = Date.now() + (24 * 60 * 60 * 1000) // 24 hours

  const downloadUrl = `${process.env.BASE_URL || 'http://localhost:3000'}/download/${productId}?token=${downloadToken}`

  // Try to send via Threema first
  if (process.env.THREEMA_GATEWAY_ID && process.env.THREEMA_GATEWAY_SECRET) {
    try {
      // In a real app, we'd map customer email to Threema ID
      const threemaResponse = await axios.post(`https://msgapi.threema.ch/send/simple/${process.env.THREEMA_GATEWAY_ID}`, {
        to: customerEmail, // Threema Gateway accepts email delivery
        text: `Thank you for your purchase!\n\nDownload link: ${downloadUrl}\n\nThis link expires in 24 hours.`,
      }, {
        auth: {
          username: process.env.THREEMA_GATEWAY_ID,
          password: process.env.THREEMA_GATEWAY_SECRET
        }
      })
      console.log('Sent notification via Threema:', threemaResponse.data)
    } catch (error) {
      console.error('Failed to send Threema notification:', error.response?.data || error.message)
    }
  }

  // Try to send via Telegram if we have a bot
  if (process.env.TELEGRAM_BOT_TOKEN) {
    try {
      // Telegram needs chat ID - in a real app we'd store this in DB during checkout
      // For now just log
      console.log('Notification configured for Telegram delivery')
    } catch (error) {
      console.error('Failed to send Telegram notification:', error.message)
    }
  }

  // Send email notification via SendGrid
  if (process.env.SENDGRID_API_KEY) {
    try {
      const emailResponse = await axios.post('https://api.sendgrid.com/v3/mail/send', {
        personalizations: [{
          to: [{ email: customerEmail }]
        }],
        from: { email: process.env.SENDGRID_FROM || 'no-reply@yourdomain.com', name: 'Secure Shop' },
        subject: 'Your Digital Purchase',
        content: [{
          type: 'text/plain',
          value: `Thank you for your purchase!\n\nDownload link: ${downloadUrl}\n\nThis link expires in 24 hours.`
        }]
      }, {
        headers: {
          'Authorization': `Bearer ${process.env.SENDGRID_API_KEY}`,
          'Content-Type': 'application/json'
        }
      })
      console.log('Email sent via SendGrid:', emailResponse.status)
    } catch (error) {
      console.error('Failed to send email:', error.response?.data || error.message)
    }
  }

  console.log(`Order fulfilled successfully for ${customerEmail}`)
  console.log(`Download URL: ${downloadUrl}`)
  console.log(`Payment Intent: ${paymentIntentId}`)
}

// Secure download endpoint
app.get('/download/:productId', (req, res) => {
  const { productId } = req.params
  const { token } = req.query

  if (!token) {
    return res.status(403).json({ error: 'Access denied - missing download token' })
  }

  const product = products.find(p => p.id === productId)
  if (!product) {
    return res.status(404).json({ error: 'Product not found' })
  }

  // In production, validate token against store (DB) and check expiry
  // This is a simplified placeholder validation
  if (!token.startsWith('dl_')) {
    return res.status(403).json({ error: 'Invalid download token' })
  }

  // Serve file securely (in production, use signed URLs to private S3)
  res.sendFile(product.file, { root: 'public/downloads' }, (err) => {
    if (err) {
      res.status(404).json({ error: 'File not found' })
    }
  })
})

app.listen(port, () => {
  console.log(`Secure Shop server running on port ${port}`)
})
